'use strict';

const cheerio = require('cheerio');
const { lancarNavegador } = require('../lib/browser');

// Margem de segurança abaixo do "maxDuration" configurado em vercel.json
// (300s). Paramos um pouco antes para conseguir fechar o browser e enviar o
// evento "fim" antes da Vercel matar a função à força.
const DURACAO_MAXIMA_MS = 280 * 1000;
const TIMEOUT_PAGINA_MS = 15000;
const MAX_PAGINAS_PADRAO = 40;
const MAX_PAGINAS_LIMITE = 150;

module.exports = async (req, res) => {
  const { url, types, maxPages } = req.query;

  if (!url) {
    res.status(400).send('URL não fornecida.');
    return;
  }

  let urlInicial;
  try {
    urlInicial = new URL(url);
    if (!['http:', 'https:'].includes(urlInicial.protocol)) {
      throw new Error('protocolo inválido');
    }
  } catch (e) {
    res.status(400).send('URL inválida. Use uma URL completa, ex.: https://exemplo.com');
    return;
  }

  const tiposPermitidos = types ? String(types).split(',') : ['svg'];
  const limitePaginas = Math.min(
    Math.max(parseInt(maxPages, 10) || MAX_PAGINAS_PADRAO, 1),
    MAX_PAGINAS_LIMITE
  );

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Evita que proxies/CDNs façam buffering da resposta em streaming.
    'X-Accel-Buffering': 'no',
  });

  const enviar = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      // conexão já fechada pelo cliente, ignora
    }
  };

  enviar({ tipo: 'status', mensagem: 'Iniciando robô...', urlScan: urlInicial.href, fila: 0 });

  let browser;
  let cancelado = false;
  const inicio = Date.now();

  req.on('close', () => {
    cancelado = true;
    if (browser) browser.close().catch(() => {});
  });

  try {
    const dominioAlvo = urlInicial.hostname;
    const filaUrls = [urlInicial.href];
    const urlsVisitadas = new Set([urlInicial.href]);
    const arquivosEncontrados = new Set();

    let paginasVasculhadas = 0;
    let tempoEsgotado = false;

    browser = await lancarNavegador();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    while (filaUrls.length > 0 && !cancelado) {
      if (Date.now() - inicio > DURACAO_MAXIMA_MS) {
        tempoEsgotado = true;
        break;
      }
      if (paginasVasculhadas >= limitePaginas) break;

      const urlAtual = filaUrls.shift();
      paginasVasculhadas++;

      enviar({
        tipo: 'status',
        mensagem: `Vasculhando página ${paginasVasculhadas}...`,
        urlScan: urlAtual,
        fila: filaUrls.length,
      });

      try {
        await page.goto(urlAtual, { waitUntil: 'networkidle2', timeout: TIMEOUT_PAGINA_MS });
        const html = await page.content();
        const $ = cheerio.load(html);

        const processarArquivo = (novoItem) => {
          const itemString = JSON.stringify(novoItem);
          if (!arquivosEncontrados.has(itemString)) {
            arquivosEncontrados.add(itemString);
            const logSrc = novoItem.inline ? 'SVG Embutido (Código Base64)' : novoItem.src;
            enviar({ tipo: 'arquivo', item: novoItem, logSrc });
          }
        };

        if (tiposPermitidos.includes('svg')) {
          $('img').each((_, el) => {
            const src = $(el).attr('src');
            if (src && src.toLowerCase().includes('.svg')) {
              try {
                processarArquivo({ extensao: 'svg', src: new URL(src, urlAtual).href, inline: false });
              } catch (e) {}
            }
          });

          $('svg').each((_, el) => {
            $(el).attr('xmlns', 'http://www.w3.org/2000/svg');
            const base64 = Buffer.from($.html(el)).toString('base64');
            processarArquivo({ extensao: 'svg', src: `data:image/svg+xml;base64,${base64}`, inline: true });
          });
        }

        $('a, link, object, iframe').each((_, el) => {
          const link = $(el).attr('href') || $(el).attr('data') || $(el).attr('src');
          if (!link) return;

          const extensaoEncontrada = tiposPermitidos.find((ext) =>
            link.toLowerCase().split('?')[0].endsWith('.' + ext)
          );
          if (extensaoEncontrada) {
            try {
              processarArquivo({ extensao: extensaoEncontrada, src: new URL(link, urlAtual).href, inline: false });
            } catch (e) {}
          }

          try {
            if ($(el).is('a')) {
              const novaUrlObj = new URL(link, urlAtual);
              novaUrlObj.hash = '';
              const novaUrl = novaUrlObj.href;

              if (novaUrlObj.hostname === dominioAlvo && !urlsVisitadas.has(novaUrl)) {
                urlsVisitadas.add(novaUrl);
                filaUrls.push(novaUrl);
              }
            }
          } catch (e) {}
        });
      } catch (erroPagina) {
        // ignora página com erro/timeout e segue para a próxima da fila
      }
    }

    if (!cancelado) {
      enviar({
        tipo: 'fim',
        totalArquivos: arquivosEncontrados.size,
        totalPaginas: paginasVasculhadas,
        limiteAtingido: tempoEsgotado || paginasVasculhadas >= limitePaginas,
      });
      res.end();
    }
  } catch (error) {
    console.error('Erro crítico ao vasculhar site:', error);
    if (!cancelado) {
      enviar({
        tipo: 'erro',
        mensagem: 'Erro crítico ao processar o site: ' + (error && error.message ? error.message : 'desconhecido'),
      });
      res.end();
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
};
