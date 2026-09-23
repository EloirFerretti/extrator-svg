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
 *  1. Se houver um Chrome/Edge instalado localmente (via
 *     CHROME_EXECUTABLE_PATH ou autodetectado nos caminhos padrão), usa ele.
 *     É o caso normal de desenvolvimento local (`vercel dev`, `node`, etc).
 *  2. Senão, se o processo estiver rodando em Linux — que é o caso do
 *     runtime das funções na Vercel/AWS Lambda, onde não existe nenhum
 *     Chrome de desktop instalado — baixa e usa o Chromium do
 *     @sparticuz/chromium-min via PACOTE_CHROMIUM_URL.
 *
 * Importante: não dá para confiar em variáveis de ambiente (tipo
 * process.env.VERCEL ou variáveis internas do AWS Lambda) para diferenciar
 * "rodando na Vercel" de "rodando localmente", porque a Vercel não garante
 * repassar essas variáveis internas para o runtime da função. Por isso a
 * decisão aqui é feita da forma mais direta possível: existe um navegador
 * instalado no disco ou não.
 */
async function lancarNavegador() {
  const puppeteer = require('puppeteer-core');
  const caminhoManual = process.env.CHROME_EXECUTABLE_PATH;
  const caminhoLocal = caminhoManual || detectarChromeLocal();

  if (caminhoLocal) {
    return puppeteer.launch({
      executablePath: caminhoLocal,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }

  if (process.platform === 'linux') {
    const chromium = require('@sparticuz/chromium-min');
    chromium.setGraphicsMode = false;

    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(PACOTE_CHROMIUM_URL),
      headless: chromium.headless,
    });
  }

  throw new Error(
    'Chrome/Chromium não encontrado neste ambiente local. Instale o Google ' +
      'Chrome (ou Edge) ou defina a variável de ambiente ' +
      'CHROME_EXECUTABLE_PATH apontando para o executável do navegador.'
  );
}

module.exports = { lancarNavegador };
