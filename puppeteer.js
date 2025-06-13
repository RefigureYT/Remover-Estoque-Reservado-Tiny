/*
 * Copyright (c) 2025 Kelvin Kauan Melo Mattos
 * Proibido o uso, cópia ou modificação sem autorização expressa.
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { Client } = require("pg");
const { fetch } = require("undici"); // Isso funciona com require normalmente
const { error } = require("console");
const puppeteer = require("puppeteer");
const { setTimeout } = require("timers");
const { RETRY_DELAY } = require("puppeteer");
const { execFileSync } = require("child_process");
const { evaluationString } = require("puppeteer");
const { arrayBuffer } = require("stream/consumers");

// VARIÁVEIS DO SCRIPT
// Lê e converte o arquivo JSON
let db = {};
let tiny = {};

let diretorioFiles = "./files";
let arquivosXLS;
const caminhoCredenciais = path.join(diretorioFiles, "credentials.json");
const caminhoFeitos = path.join(__dirname, diretorioFiles, "produtosFeitos.txt");

// FUNÇÕES DO SCRIPT
function contarArquivosXLS(diretorio) {
    const arquivos = fs.readdirSync(diretorio);
    const arquivosXLS = arquivos.filter(arquivo => path.extname(arquivo).toLowerCase() === ".xls");
    return arquivosXLS;
}
arquivosXLS = contarArquivosXLS(diretorioFiles) // Define o valor da variável
const caminhoArquivo = path.join(diretorioFiles, arquivosXLS[0]);
const workbook = xlsx.readFile(caminhoArquivo);// Lê a planilha
const primeiraAba = workbook.SheetNames[0]; // Assume a primeira aba
const planilha = workbook.Sheets[primeiraAba];
const linhas = xlsx.utils.sheet_to_json(planilha, { header: 1 }); // Converte a planilha em JSON
linhas.shift(); // Remove a primeira linha (cabeçalhos)

const objetos = linhas.map(linha => {
    return {
        sku: linha[1],
        un: Number(linha[2])
    };
});

/**
* Salva um objeto JSON como string em uma nova linha dentro de logs_req.txt
* @param {Object} objeto - O objeto que será salvo no arquivo
*/

function salvarLogRequisicao(objeto) {
    const caminho = path.join(__dirname, diretorioFiles, "logs_req.txt");
    const dataHora = new Date().toISOString();
    const linha = `[${dataHora}] ${JSON.stringify(objeto)}\n`;

    fs.appendFileSync(caminho, linha, "utf8");
}
// Lê o conteúdo de produtosFeitos.txt
function carregarProdutosFeitos() {
    if (!fs.existsSync(caminhoFeitos)) return [];

    const linhas = fs.readFileSync(caminhoFeitos, "utf8").split("\n").filter(Boolean);

    return linhas.map(linha => {
        const matchSKU = linha.match(/SKU:\s*(\S+)/);
        const matchUN = linha.match(/UN:\s*(\d+)/);
        return {
            sku: matchSKU ? matchSKU[1] : null,
            un: matchUN ? Number(matchUN[1]) : null
        };
    }).filter(p => p.sku && !isNaN(p.un));
}

const produtosFeitos = carregarProdutosFeitos();

const estoqueReservado = objetos.filter(item => {
    if (item.un <= 0) return false;

    const feito = produtosFeitos.find(p => p.sku === item.sku);
    if (!feito) return true;

    return item.un !== feito.un; // Só mantém se quantidade for diferente
});
console.log("Total de produtos com estoque reservado:", estoqueReservado.length);

function adicionarLinhaProdutoFeito(objeto) {
    const caminho = caminhoFeitos;
    const linha = "SKU: " + objeto.sku + " |  UN: " + objeto.un + "\n";

    try {
        fs.appendFileSync(caminho, linha, "utf8");
        console.log("Adicionado à produtosFeitos.txt: " + linha);
    } catch (erro) {
        console.error("Erro ao escrever no arquivo:", erro.message);
        process.exit(1);
    }
}

async function buscarChave() {
    const client = new Client({
        host: db.ip,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database
    });

    try {
        await client.connect();

        const query = `SELECT * FROM ${db.table} WHERE id = $1 LIMIT 1`;
        const res = await client.query(query, [db.id_row]);

        if (res.rows.length > 0) {
            const dados = res.rows[0];
            console.log("🔑 Chave de acesso capturada com sucesso!");
            return dados;
        } else {
            console.error("❌ Nenhum registro encontrado com id =", db.id_row);
            return null;
        }
    } catch (err) {
        console.error("❌ Erro ao buscar dados:", err.message);
        return null;
    } finally {
        await client.end();
    }
}

async function getIdProdutoTiny(sku) {
    const baseUrl = "https://api.tiny.com.br/public-api/v3";
    const tokens = await buscarChave();

    const params = new URLSearchParams({
        codigo: sku,
        situacao: "A"
    });

    const url = `${baseUrl}/produtos?${params.toString()}`;
    try {

        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${tokens.access_token}`
            }
        });

        const dados = await response.json();
        console.log("✅ Requisição realizada com sucesso!");
        return dados;
    } catch (erro) {
        console.error("❌ Erro na requisição GET:", erro.message);
        return null;
    }
}

function log(mensagem) {
    console.log(mensagem);
}

async function getTotalPaginas(page) {
    const seletorPaginacao = "#divPaginacaoBottom > ul";
    try {
        await page.waitForSelector(seletorPaginacao, { timeout: 5000 });
    } catch (e) {
        console.log("Seletor de paginação não encontrado, assumindo 1 página.", e.message);
        return 1;
    }

    const ultimaPagina = await page.evaluate((seletor) => {
        const paginacao = document.querySelector(seletor);
        if (!paginacao) return 1; // Se não houver paginação, considera apenas 1 página

        const links = Array.from(paginacao.querySelectorAll("a.link-pg"));
        const linksNumericos = links.filter(link => /\d+/.test(link.innerText) && !link.querySelector("i")); // Filtra apenas os links com números e sem ícones

        if (linksNumericos.length === 0) return 1; // Se não houver links numéricos, considera 1 página

        // Pega o texto do último link numérico antes do botão "próximo" ou do último link numérico se não houver "próximo"
        let ultimoLinkNumerico;
        const linkProximo = paginacao.querySelector("li.pnext a");

        if (linkProximo) {
            const elementosLi = Array.from(paginacao.children);
            const indiceProximo = elementosLi.findIndex(li => li.classList.contains("pnext"));
            if (indiceProximo > 0) {
                // Pega o <a> dentro do <li> anterior ao "pnext"
                const liAnterior = elementosLi[indiceProximo - 1];
                if (liAnterior && liAnterior.querySelector("a.link-pg")) {
                    ultimoLinkNumerico = liAnterior.querySelector("a.link-pg");
                }
            }
        }

        // Se não encontrou pelo método acima (ou não tem "pnext"), pega o último link numérico diretamente
        if (!ultimoLinkNumerico && linksNumericos.length > 0) {
            ultimoLinkNumerico = linksNumericos[linksNumericos.length - 1];
        }

        return ultimoLinkNumerico ? parseInt(ultimoLinkNumerico.innerText.trim(), 10) : 1;
    }, seletorPaginacao);

    console.log(`Total de páginas encontradas: ${ultimaPagina}`);
    return ultimaPagina;
}

async function getCurrentPageNumber(page) {
    const seletorPaginacaoAtiva = "#divPaginacaoBottom > ul > li.active > a";
    try {
        await page.waitForSelector(seletorPaginacaoAtiva, { timeout: 5000 });
        const currentPageText = await page.$eval(seletorPaginacaoAtiva, el => el.innerText.trim());
        return parseInt(currentPageText, 10);
    } catch (error) {
        console.log("Não foi possível determinar a página atual, assumindo 1:", error.message);
        return 1; // Retorna 1 se não conseguir encontrar a página ativa
    }
}


// VERIFICAÇÕES DO SCRIPT

// Verifica se o arquivo existe
if (arquivosXLS.length != 1) {
    console.error("Diretório \"files\" deve conter apenas 1 arquivo .xls!");
    process.exit(1);
}

if (!fs.existsSync(caminhoCredenciais)) {
    console.error("Arquivo \"credentials.json\" não existe!");
    process.exit(1);
}

// Verifica se o arquivo está vazio
if (fs.statSync(caminhoCredenciais).size === 0) {
    console.error("Arquivo \"credentials.json\" está vazio!");
    process.exit(1);
}

try {
    const conteudo = fs.readFileSync(caminhoCredenciais, "utf8");
    const credenciais = JSON.parse(conteudo);

    if (credenciais.db) {
        db = credenciais.db;
    }

    if (credenciais.tiny) {
        tiny = credenciais.tiny;
    }

    console.log("Credenciais carregadas com sucesso!");
} catch (err) {
    console.error("Erro ao carregar credentials.json:", err.message);
    process.exit(1);
}

const filtroDataMinima = {
    dia: tiny.date_day,
    mes: tiny.date_mounth,
    ano: tiny.date_year
};

async function capturarReservasValidas(page, filtro) {
    return await page.evaluate((f) => {
        const linhas = Array.from(document.querySelectorAll("#tabelalancamentos tbody tr"));
        const dataLimite = new Date(f.ano, f.mes - 1, f.dia + 1);
        dataLimite.setHours(0, 0, 0, 0);

        return linhas.map(tr => {
            const checkbox = tr.querySelector("input[type=\"checkbox\"]");
            const idReserva = checkbox?.value?.trim();

            const dataTexto = tr.children[2]?.innerText?.trim();
            const qtdTexto = tr.children[3]?.innerText?.trim();
            const qtd = parseFloat(qtdTexto.replace(",", "."));

            const [data, hora] = dataTexto.split(" - ");
            const [dia, mes, ano] = data.split("/");
            const dataISO = new Date(`${ano}-${mes}-${dia}T${hora || "00:00"}`);

            return {
                idReserva,
                quantidade: qtd,
                dataOriginal: dataTexto,
                dataISO: dataISO.toISOString(),
                dataObj: dataISO
            };
        }).filter(reserva => reserva.dataObj < dataLimite && reserva.idReserva);
    }, filtro);
}

async function navegarParaPagina(page, numeroPagina) {
    console.log(`Navegando para a página ${numeroPagina}...`);
    await page.evaluate((numPag) => {
        irParaPagina(numPag, listar); // Chama a função global da página
    }, numeroPagina);
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => {
        console.log(`Timeout ou erro ao esperar navegação para página ${numeroPagina}, continuando...`);
    });
    await new Promise(resolve => setTimeout(resolve, 3000)); // Pausa extra para garantir carregamento
}

// Inicia SCRIPT

(async () => {
    const browser = await puppeteer.launch({ headless: false, args: ["--start-maximized"] });
    const page = await browser.newPage();

    await page.goto("https://tiny.com.br/login");

    // Espera 3 segundos
    await new Promise(resolve => setTimeout(resolve, 3000));

    await page.click("input[name=\"username\"]"); // Foca no campo User
    await page.type("input[name=\"username\"]", tiny.user); // Digita usuário

    await page.click("button"); // Clica em Avançar

    await page.click("input[name=\"password\"]"); // Foca no campo Password
    await page.type("input[name=\"password\"]", tiny.password); // Digita a senha

    await page.evaluate(() => { // Clica no botão Entrar
        document.querySelectorAll("button")[1].click();
    });

    // Espera 5 segundos antes de verificar se tem alguém logado
    await new Promise(resolve => setTimeout(resolve, 5000));

    const resultado = await page.evaluate(() => {
        const botaoLogin = document.querySelector("button.btn.btn-primary");

        if (botaoLogin && botaoLogin.innerText.toLowerCase().includes("login")) {
            botaoLogin.click();
            return "Havia um usuário logado, foi desconectado automaticamente.";
        } else {
            return "Não havia ninguém logado.";
        }
    });

    log(resultado);

    for (const produto of estoqueReservado) {
        console.log("SKU: " + produto.sku);
        let prodInfo = await getIdProdutoTiny(produto.sku);

        if (!prodInfo || !prodInfo.itens || prodInfo.itens.length === 0) {
            console.log(`❌ Produto com SKU ${produto.sku} não encontrado ou sem ID no Tiny. Pulando...`);
            adicionarLinhaProdutoFeito(produto); // Adiciona ao log de feitos para não tentar novamente
            continue;
        }

        // Espera 3 segundos antes de navegar
        await new Promise(resolve => setTimeout(resolve, 3000));

        salvarLogRequisicao(prodInfo);
        // Vai para a página de produtos na mesma aba
        await page.goto(`https://erp.tiny.com.br/estoque?buscaid=${prodInfo.itens[0].id}&deposito=true`);

        // Clica na aba de reservas
        await new Promise(resolve => setTimeout(resolve, 3000)); // Espera um pouco antes de clicar na aba
        await page.waitForSelector("a[onclick*=\"trocarAba(\'reservas\')\"]", { timeout: 10000 });
        await page.click("a[onclick*=\"trocarAba(\'reservas\')\"]");
        await new Promise(resolve => setTimeout(resolve, 5000)); // Pausa para a aba carregar

        let totalPaginas;
        try {
            await page.waitForSelector("#tabelalancamentos tbody tr", { timeout: 10000 }); // Aguarda o carregamento inicial da tabela
            totalPaginas = await getTotalPaginas(page);
        } catch (e) {
            // Verifica se é a mensagem "Você não possui nenhum item cadastrado."
            const msgSemRegistros = await page.$eval(
                "#page-wrapper > div.panel.panel-list > div.panel-body > div.page-list-empty-state > div.empty-state-box.empty-state-box-sem-registros > h4",
                el => el.innerText
            ).catch(() => null);

            if (msgSemRegistros === "Você não possui nenhum item cadastrado.") {
                console.log("ℹ️ Produto sem nenhuma reserva, pulando para o próximo...");
                adicionarLinhaProdutoFeito(produto);
                continue;
            } else {
                console.log(`❌ Erro ao tentar verificar reservas ou obter paginação para o SKU ${produto.sku}: ${e.message}`);
                adicionarLinhaProdutoFeito(produto); // Adiciona para não tentar novamente este produto
                continue;
            }
        }

        for (let i = 0; i < 5; i++) { // Scroll para carregar todos os elementos da primeira página
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (totalPaginas > 1) {
            await navegarParaPagina(page, totalPaginas); // Navega para a última página
        }

        for (let paginaAtual = totalPaginas; paginaAtual >= 1; paginaAtual--) {
            // Reavaliar o número total de páginas e a página atual real no início de cada iteração
            // para garantir que estamos sempre trabalhando com o estado mais recente da paginação.
            totalPaginas = await getTotalPaginas(page); // Re-obtem o total de páginas
            const paginaAtualReal = await getCurrentPageNumber(page);

            console.log(`Após exclusão na página ${paginaAtual}: Novo total de páginas: ${totalPaginas}, Página atual real: ${paginaAtualReal}`);

            // Se a página atual real não for a página que esperamos processar, navegue para ela.
            // Isso cobre casos onde a exclusão de uma página anterior nos moveu automaticamente.
            if (paginaAtualReal !== paginaAtual) {
                console.log(`Página atual real (${paginaAtualReal}) diferente da esperada (${paginaAtual}). Ajustando navegação.`);
                // Se a página real for menor que a esperada, significa que a página esperada pode ter sumido.
                // Ajustamos a paginaAtual para a paginaAtualReal para que o loop continue a partir da página correta.
                if (paginaAtualReal < paginaAtual) {
                    paginaAtual = paginaAtualReal;
                }
                await navegarParaPagina(page, paginaAtual);
            }

            console.log(`Processando página ${paginaAtual} de ${totalPaginas}`);

            let reservas;
            try {
                await page.waitForSelector("#tabelalancamentos tbody tr", { timeout: 10000 });
                for (let i = 0; i < 5; i++) { // Scroll para carregar todos os elementos da página atual
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                reservas = await capturarReservasValidas(page, filtroDataMinima);
            } catch (err) {
                console.log(`❌ Erro ao capturar reservas na página ${paginaAtual} para o SKU ${produto.sku}: ${err.message}. Pulando para a próxima página/produto.`);
                continue; // Pula para a próxima iteração do loop de páginas
            }

            const idsParaExcluir = reservas.map(r => r.idReserva);

            if (idsParaExcluir.length > 0) {
                console.log(`Reservas encontradas na página ${paginaAtual}: ${reservas.length}`);
                reservas.forEach((r, i) => {
                    console.log(`  Reserva ${i + 1}: Quantidade: ${r.quantidade}, Data: ${r.dataOriginal}`);
                });

                for (const id of idsParaExcluir) {
                    try {
                        await page.waitForSelector(`#marcado${id}`, { visible: true, timeout: 5000 });
                        await page.click(`#marcado${id}`);
                        await new Promise(resolve => setTimeout(resolve, 200)); // Pequena pausa entre cliques
                    } catch (e) {
                        console.log(`🟡 Checkbox para reserva ${id} não encontrado ou não clicável na página ${paginaAtual}.`);
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
                // 1. Clica no botão "Ações"
                await page.waitForSelector("#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active > div.dropdown.dropup.dropdown-in.featured-actions-menu > button", { visible: true, timeout: 10000 });
                await page.click("#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active > div.dropdown.dropup.dropdown-in.featured-actions-menu > button");
                await new Promise(resolve => setTimeout(resolve, 1000));
                // 2. Espera o botão "Excluir lançamentos" aparecer
                await page.waitForSelector("#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a", { visible: true, timeout: 10000 });
                await new Promise(resolve => setTimeout(resolve, 1000));
                // 3. Clica no botão "Excluir lançamentos"
                await page.click("#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a");
                await new Promise(resolve => setTimeout(resolve, 1000));
                // 4. Confirma exclusão no modal
                await page.waitForSelector("#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary", { visible: true, timeout: 10000 });
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click("#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary");
                console.log(`Foram excluídas ${idsParaExcluir.length} reserva(s) na página ${paginaAtual}.`);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Espera a página recarregar/atualizar

            } else {
                console.log(`Nenhuma reserva para excluir na página ${paginaAtual}.`);
            }
        }
        adicionarLinhaProdutoFeito(produto);
        console.log(`SKU ${produto.sku} finalizado.`);
    }

    console.log("🎉 Script finalizado com sucesso!");
    await browser.close();
})();

// 13/06/2025 - Modificações para iterar da última para a primeira página.