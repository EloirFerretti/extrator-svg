'use strict';

const fs = require('fs');

// Versão do Chromium usada em produção. Precisa ser uma versão do
// @sparticuz/chromium-min anterior à v149 (a partir da v149 o pacote deixou
// de suportar CommonJS/require e passou a ser ESM-only). Se um dia quiser
// atualizar, troque a versão aqui E garanta que a versão do puppeteer-core
// no package.json continua compatível.
const CHROMIUM_MIN_VERSION = '148.0.0';

// URL do "pack" do Chromium pronto para Lambda/Vercel, hospedado pelo próprio
// mantenedor do @sparticuz/chromium. Pode ser sobrescrita pela env var
// CHROMIUM_PACK_URL caso você prefira hospedar sua própria cópia (por
// exemplo, em /public do seu próprio projeto) para não depender do GitHub.
const PACOTE_CHROMIUM_URL =
  process.env.CHROMIUM_PACK_URL ||
  `https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_MIN_VERSION}/chromium-v${CHROMIUM_MIN_VERSION}-pack.x64.tar`;

/**
 * Só retorna true dentro do runtime real da função na Vercel (produção/preview),
 * que roda em cima do AWS Lambda.
 *
 * Importante: "vercel dev" (ambiente de desenvolvimento local) também define
 * process.env.VERCEL=1, mas NÃO roda dentro do Lambda de verdade — por isso
 * não usamos essa variável aqui. Usamos, em vez disso, variáveis que só
 * existem dentro do runtime do Lambda, para decidir se baixamos o binário
 * Linux do Chromium ou usamos um Chrome/Edge já instalado na máquina local.
 */
function estaNoRuntimeServerless() {
  return Boolean(
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.AWS_EXECUTION_ENV
  );
}

function detectarChromeLocal() {
  const candidatos =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ];

  return candidatos.find((caminho) => {
    try {
      return fs.existsSync(caminho);
    } catch (e) {
      return false;
    }
  });
}

/**
 * Lança o navegador Puppeteer, escolhendo automaticamente a estratégia certa
 * para o ambiente atual:
 *  - Em produção/preview na Vercel: usa @sparticuz/chromium-min, que baixa um
 *    Chromium compatível com Lambda a partir de PACOTE_CHROMIUM_URL.
 *  - Localmente (ex.: `vercel dev` ou `node`): usa um Chrome/Edge já
 *    instalado na máquina, seja via CHROME_EXECUTABLE_PATH ou autodetectado.
 */
async function lancarNavegador() {
  const puppeteer = require('puppeteer-core');
  const caminhoManual = process.env.CHROME_EXECUTABLE_PATH;

  if (estaNoRuntimeServerless() && !caminhoManual) {
    const chromium = require('@sparticuz/chromium-min');
    chromium.setGraphicsMode = false;

    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(PACOTE_CHROMIUM_URL),
      headless: chromium.headless,
    });
  }

  const executablePath = caminhoManual || detectarChromeLocal();
  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium não encontrado neste ambiente local. Instale o Google ' +
        'Chrome (ou Edge) ou defina a variável de ambiente ' +
        'CHROME_EXECUTABLE_PATH apontando para o executável do navegador.'
    );
  }

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

module.exports = { lancarNavegador, estaNoRuntimeServerless };
