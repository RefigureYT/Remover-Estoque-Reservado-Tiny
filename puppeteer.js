/*
 * Copyright (c) 2025 Kelvin Kauan Melo Mattos
 * Proibido o uso, cópia ou modificação sem autorização expressa.
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { Client } = require('pg');
const { fetch } = require('undici'); // Isso funciona com require normalmente
const { error } = require('console');
const puppeteer = require('puppeteer');
const { setTimeout } = require('timers');
const { RETRY_DELAY } = require('puppeteer');
const { execFileSync } = require('child_process');
const { evaluationString } = require('puppeteer');
const { arrayBuffer } = require('stream/consumers');

// VARIÁVEIS DO SCRIPT
// Lê e converte o arquivo JSON
let db = {};
let tiny = {};

let diretorioFiles = "./files";
let arquivosXLS;
const caminhoCredenciais = path.join(diretorioFiles, 'credentials.json');

// FUNÇÕES DO SCRIPT
function contarArquivosXLS(diretorio) {
    const arquivos = fs.readdirSync(diretorio);
    const arquivosXLS = arquivos.filter(arquivo => path.extname(arquivo).toLowerCase() === '.xls');
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

// Lê o conteúdo de produtosFeitos.txt
function carregarProdutosFeitos() {
    if (!fs.existsSync(caminhoFeitos)) return [];

    const linhas = fs.readFileSync(caminhoFeitos, 'utf8').split('\n').filter(Boolean);

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

console.log("Total de produtos com estoque reservado: " + estoqueReservado.length);

function adicionarLinhaProdutoFeito(objeto) {
    const caminho = path.join(__dirname, diretorioFiles, 'produtosFeitos.txt');
    const linha = "SKU: " + objeto.sku + " |  UN: " + objeto.un + "\n";

    try {
        fs.appendFileSync(caminho, linha, 'utf8');
    } catch (erro) {
        console.error('Erro ao escrever no arquivo:', erro.message);
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
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`
            }
        });

        const dados = await response.json();
        console.log('✅ Requisição realizada com sucesso!');
        return dados;
    } catch (erro) {
        console.error('❌ Erro na requisição GET:', erro.message);
        return null;
    }
}

function log(mensagem) {
    console.log(mensagem);
}




// VERIFICAÇÕES DO SCRIPT

// Verifica se o arquivo existe
if (arquivosXLS.length != 1) {
    console.error("Diretório \"files\" deve conter apenas 1 arquivo .xls!");
    process.exit(1);
}

if (!fs.existsSync(caminhoCredenciais)) {
    console.error('Arquivo "credentials.json" não existe!');
    process.exit(1);
}

// Verifica se o arquivo está vazio
if (fs.statSync(caminhoCredenciais).size === 0) {
    console.error('Arquivo "credentials.json" está vazio!');
    process.exit(1);
}

try {
    const conteudo = fs.readFileSync(caminhoCredenciais, 'utf8');
    const credenciais = JSON.parse(conteudo);

    if (credenciais.db) {
        db = credenciais.db;
    }

    if (credenciais.tiny) {
        tiny = credenciais.tiny;
    }

    console.log("Credenciais carregadas com sucesso!");
} catch (err) {
    console.error('Erro ao carregar credentials.json:', err.message);
    process.exit(1);
}

const filtroDataMinima = {
    dia: tiny.date_day,
    mes: tiny.date_mounth,
    ano: tiny.date_year
};

async function excluirReservasNasPaginas(page, filtroDataMinima) {
    let encontrouMaisReservas = false;

    while (true) {
        const temProxima = await page.$('#divPaginacaoBottom > ul > li.pnext > a');
        if (!temProxima) {
            console.log("⛔ Nenhuma próxima página de reservas encontrada.");
            break;
        }

        console.log("➡️ Indo para a próxima página...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => { }),
            page.click('#divPaginacaoBottom > ul > li.pnext > a'),
        ]);

        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
            await page.waitForSelector('#tabelalancamentos tbody tr', { timeout: 5000 });

            const reservas = await page.evaluate((filtro) => {
                const linhas = Array.from(document.querySelectorAll('#tabelalancamentos tbody tr'));
                const dataLimite = new Date(`${filtro.ano}-${String(filtro.mes).padStart(2, '0')}-${String(filtro.dia).padStart(2, '0')}`);
                dataLimite.setHours(0, 0, 0, 0);

                return linhas.map(tr => {
                    const checkbox = tr.querySelector('input[type="checkbox"]');
                    const idReserva = checkbox?.value?.trim();

                    const dataTexto = tr.children[2]?.innerText?.trim();
                    const qtdTexto = tr.children[3]?.innerText?.trim();
                    const qtd = parseFloat(qtdTexto.replace(',', '.'));

                    const [data, hora] = dataTexto.split(' - ');
                    const [dia, mes, ano] = data.split('/');
                    const dataISO = new Date(`${ano}-${mes}-${dia}T${hora || '00:00'}`);
                    const dataComparacao = new Date(dataISO);
                    dataComparacao.setHours(0, 0, 0, 0);

                    return {
                        idReserva,
                        quantidade: qtd,
                        dataOriginal: dataTexto,
                        dataISO: dataISO.toISOString(),
                        dataObj: dataISO,
                        dataComparacao
                    };
                }).filter(reserva => reserva.dataComparacao <= dataLimite && reserva.idReserva);
            }, filtroDataMinima);

            if (reservas.length > 0) {
                for (const id of reservas.map(r => r.idReserva)) {
                    await page.click(`#marcado${id}`);
                }

                console.log("🔁 Reservas encontradas em página seguinte:", reservas.length);
                reservas.forEach((r, i) => {
                    console.log(`Reserva ${i + 1}: ${r.quantidade} - ${r.dataOriginal}`);
                });

                // Clica no botão "Ações"
                await page.click('button.btn-menu-acoes.dropdown-toggle');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.waitForSelector('a.act-excluir-reservas', { visible: true });
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click('a.act-excluir-reservas');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.waitForSelector('#bs-modal-ui-popup .modal-footer .btn-primary');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click('#bs-modal-ui-popup .modal-footer .btn-primary');

                console.log("✅ Excluído após navegar para próxima página.");
                encontrouMaisReservas = true;
            } else {
                console.log("🟡 Página acessada, mas ainda sem reservas para excluir. Verificando próxima...");
            }

        } catch (erro) {
            console.log("❌ Erro ao tentar buscar reservas em nova página.");
            break;
        }
    }

    return encontrouMaisReservas;
}

// Inicia SCRIPT

(async () => {
    const browser = await puppeteer.launch({ headless: false, args: ['--start-maximized'] });
    const page = await browser.newPage();

    await page.goto('https://tiny.com.br/login');

    // Espera 3 segundos
    await new Promise(resolve => setTimeout(resolve, 3000));

    await page.click('input[name="username"]'); // Foca no campo User
    await page.type('input[name="username"]', tiny.user); // Digita usuário

    await page.click('button'); // Clica em Avançar

    await page.click('input[name="password"]'); // Foca no campo Password
    await page.type('input[name="password"]', tiny.password); // Digita a senha

    await page.evaluate(() => { // Clica no botão Entrar
        document.querySelectorAll('button')[1].click();
    });

    // Espera 5 segundos antes de verificar se tem alguém logado
    await new Promise(resolve => setTimeout(resolve, 5000));

    const resultado = await page.evaluate(() => {
        const botaoLogin = document.querySelector('button.btn.btn-primary');

        if (botaoLogin && botaoLogin.innerText.toLowerCase().includes('login')) {
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
        let reservas = [];
        // Espera 3 segundos antes de navegar
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Vai para a página de produtos na mesma aba
        await page.goto(`https://erp.tiny.com.br/estoque?buscaid=${prodInfo.itens[0].id}&deposito=true`);

        console.log(prodInfo);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await page.click('a[onclick*="trocarAba(\'reservas\')"]');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa para poder modificar o HTML manualmente (Afins de depuração)        

        try {
            await page.waitForSelector('#tabelalancamentos tbody tr', { timeout: 5000 }); // aguarda o carregamento
            await new Promise(resolve => setTimeout(resolve, 1000));
            reservas = await page.evaluate((filtro) => {
                const linhas = Array.from(document.querySelectorAll('#tabelalancamentos tbody tr'));

                const dataLimite = new Date(`${filtro.ano}-${String(filtro.mes).padStart(2, '0')}-${String(filtro.dia).padStart(2, '0')}`);
                dataLimite.setHours(0, 0, 0, 0); // ignora horário

                return linhas.map(tr => {
                    const checkbox = tr.querySelector('input[type="checkbox"]');
                    const idReserva = checkbox?.value?.trim();

                    const dataTexto = tr.children[2]?.innerText?.trim();
                    const qtdTexto = tr.children[3]?.innerText?.trim();
                    const qtd = parseFloat(qtdTexto.replace(',', '.'));

                    const [data, hora] = dataTexto.split(' - ');
                    const [dia, mes, ano] = data.split('/');
                    const dataISO = new Date(`${ano}-${mes}-${dia}T${hora || '00:00'}`);
                    const dataComparacao = new Date(dataISO);
                    dataComparacao.setHours(0, 0, 0, 0);

                    return {
                        idReserva,
                        quantidade: qtd,
                        dataOriginal: dataTexto,
                        dataISO: dataISO.toISOString(),
                        dataObj: dataISO,
                        dataComparacao
                    };
                }).filter(reserva => reserva.dataComparacao <= dataLimite && reserva.idReserva);
            }, filtroDataMinima);
        } catch {
            // Verifica se é a mensagem "Você não possui nenhum item cadastrado."
            const msgSemRegistros = await page.$eval(
                '#page-wrapper > div.panel.panel-list > div.panel-body > div.page-list-empty-state > div.empty-state-box.empty-state-box-sem-registros > h4',
                el => el.innerText
            ).catch(() => null);

            if (msgSemRegistros === 'Você não possui nenhum item cadastrado.') {
                console.log("ℹ️ Produto sem nenhuma reserva, pulando para o próximo...");
                continue;
            } else {
                console.log("❌ Erro inesperado ao tentar verificar reservas.");
                continue;
            }
        }

        const idsParaExcluir = reservas.map(r => r.idReserva);

        if (idsParaExcluir.length > 0) {
            for (const id of idsParaExcluir) {
                await page.click(`#marcado${id}`);
            }

            console.log("Reservas encontradas:", reservas.length);

            reservas.forEach((r, i) => {
                console.log(`Reserva ${i + 1}:`);
                console.log(`  Quantidade: ${r.quantidade}`);
                console.log(`  Data: ${r.dataOriginal} || ${r.dataISO}`);
            });

            await new Promise(resolve => setTimeout(resolve, 1000));
            // 1. Clica no botão "Ações"
            await page.click('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active > div.dropdown.dropup.dropdown-in.featured-actions-menu > button');
            await new Promise(resolve => setTimeout(resolve, 1000));
            // 2. Espera o botão "Excluir lançamentos" aparecer (garante que o dropdown abriu)
            await page.waitForSelector('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a', { visible: true });
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 3. Clica no botão "Excluir lançamentos"
            await page.click('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a');
            await new Promise(resolve => setTimeout(resolve, 1000));

            await page.waitForSelector('#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary');
            await new Promise(resolve => setTimeout(resolve, 1000));
            await page.click('#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary');
            console.log("Foi(ram) excluído(s) " + idsParaExcluir.length + " reserva(s).");

        }
        else {
            console.log("❌ Não havia reservas para excluir. Verificando se há próxima página.");
            
            let encontrouMaisReservas = false;

            while (true) {
                const temProxima = await page.$('#divPaginacaoBottom > ul > li.pnext > a');

                if (!temProxima) {
                    console.log("⛔ Nenhuma próxima página de reservas encontrada.");
                    break;
                }

                console.log("➡️ Indo para a próxima página...");
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => { }),
                    page.click('#divPaginacaoBottom > ul > li.pnext > a'),
                ]);

                await new Promise(resolve => setTimeout(resolve, 2000));

                try {
                    await page.waitForSelector('#tabelalancamentos tbody tr', { timeout: 5000 });

                    reservas = await page.evaluate((filtro) => {
                        const linhas = Array.from(document.querySelectorAll('#tabelalancamentos tbody tr'));
                        const dataLimite = new Date(`${filtro.ano}-${String(filtro.mes).padStart(2, '0')}-${String(filtro.dia).padStart(2, '0')}`);
                        dataLimite.setHours(0, 0, 0, 0);

                        return linhas.map(tr => {
                            const checkbox = tr.querySelector('input[type="checkbox"]');
                            const idReserva = checkbox?.value?.trim();

                            const dataTexto = tr.children[2]?.innerText?.trim();
                            const qtdTexto = tr.children[3]?.innerText?.trim();
                            const qtd = parseFloat(qtdTexto.replace(',', '.'));

                            const [data, hora] = dataTexto.split(' - ');
                            const [dia, mes, ano] = data.split('/');
                            const dataISO = new Date(`${ano}-${mes}-${dia}T${hora || '00:00'}`);
                            const dataComparacao = new Date(dataISO);
                            dataComparacao.setHours(0, 0, 0, 0);

                            return {
                                idReserva,
                                quantidade: qtd,
                                dataOriginal: dataTexto,
                                dataISO: dataISO.toISOString(),
                                dataObj: dataISO,
                                dataComparacao
                            };
                        }).filter(reserva => reserva.dataComparacao <= dataLimite && reserva.idReserva);
                    }, filtroDataMinima);

                    if (reservas.length > 0) {
                        encontrouMaisReservas = true;
                        break;
                    } else {
                        console.log("🟡 Página acessada, mas ainda sem reservas para excluir. Verificando próxima...");
                    }

                } catch (erro) {
                    console.log("❌ Erro ao tentar buscar reservas em nova página.");
                    break;
                }
            }

            // Se achou reservas na próxima página, realiza exclusão normalmente
            if (encontrouMaisReservas && reservas.length > 0) {
                const idsParaExcluirNovamente = reservas.map(r => r.idReserva);

                for (const id of idsParaExcluirNovamente) {
                    await page.click(`#marcado${id}`);
                }

                console.log("🔁 Reservas encontradas em página seguinte:", reservas.length);

                reservas.forEach((r, i) => {
                    console.log(`Reserva ${i + 1}:`);
                    console.log(`  Quantidade: ${r.quantidade}`);
                    console.log(`  Data: ${r.dataOriginal} || ${r.dataISO}`);
                });

                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active > div.dropdown.dropup.dropdown-in.featured-actions-menu > button');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.waitForSelector('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a', { visible: true });
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click('#page-wrapper > div.panel.panel-list > div.bottom-bar > div:nth-child(1) > div.container-actions-selecao.featured-actions-scope.active.dropdown--is-open > div.dropdown.dropup.dropdown-in.featured-actions-menu.open > div > ul > li > a');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.waitForSelector('#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary');
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.click('#bs-modal-ui-popup > div > div > div > div.modal-footer > button.btn.btn-sm.btn-primary');
                console.log("✅ Excluído após navegar para próxima página.");
            }
        }
        adicionarLinhaProdutoFeito(produto);
        // await page.type('input[id="pesquisa-mini"]', produto.sku);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
})();

// 12/05/2025 - 15:00