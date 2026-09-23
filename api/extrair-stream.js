'use strict';

const cheerio = require('cheerio');
const { lancarNavegador } = require('../lib/browser');

// Margem de segurança abaixo do "maxDuration" configurado em vercel.json
// (300s). Cada função individual só tem esse tempo pra rodar — por isso o
// crawler é dividido em "rodadas": quando o tempo de uma rodada acaba e
// ainda sobram páginas na fila, o servidor manda o estado da busca de volta
// pro navegador, que abre uma NOVA requisição pra continuar de onde parou.
// Do ponto de vista do usuário é uma busca só, contínua.
const DURACAO_MAXIMA_MS = 280 * 1000;
const TIMEOUT_PAGINA_MS = 15000;

// Limite de segurança GLOBAL, somado entre TODAS as rodadas de uma mesma
// busca (não por rodada). Existe só pra evitar rodar pra sempre em sites com
// espaços de URL praticamente infinitos (calendários, filtros combinatórios
// etc). Pode ser ajustado via "maxPages" no corpo do primeiro request.
const MAX_PAGINAS_PADRAO = 3000;
const MAX_PAGINAS_LIMITE = 20000;

// Hash curto (FNV-1a) só pra deduplicar página/arquivo já vistos sem
// precisar carregar a URL/conteúdo inteiro de volta a cada rodada.
function hashCurto(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

module.exports = async (req, res) => {
  const corpo = req.method === 'POST' ? req.body || {} : req.query || {};
  const { url, types, maxPages, estado } = corpo;

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
  const limiteGlobalPaginas = Math.min(
    Math.max(parseInt(maxPages, 10) || MAX_PAGINAS_PADRAO, 1),
    MAX_PAGINAS_LIMITE
  );

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const enviar = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      // conexão já fechada pelo cliente, ignora
    }
  };

  const dominioAlvo = urlInicial.hostname;

  // Reidrata o estado de uma rodada anterior (continuação) ou começa do zero.
  let filaUrls;
  let visitadosHashes;
  let encontradosHashes;
  let totalPaginasAcumulado;

  if (estado && Array.isArray(estado.filaUrls)) {
    filaUrls = estado.filaUrls.slice();
    visitadosHashes = new Set(estado.visitadosHashes || []);
    encontradosHashes = new Set(estado.encontradosHashes || []);
    totalPaginasAcumulado = estado.totalPaginas || 0;
    enviar({
      tipo: 'status',
      mensagem: 'Retomando busca de onde parou...',
      urlScan: filaUrls[0] || '',
      fila: filaUrls.length,
    });
  } else {
    filaUrls = [urlInicial.href];
    visitadosHashes = new Set([hashCurto(urlInicial.href)]);
    encontradosHashes = new Set();
    totalPaginasAcumulado = 0;
    enviar({ tipo: 'status', mensagem: 'Iniciando robô...', urlScan: urlInicial.href, fila: 0 });
  }

  let browser;
  let cancelado = false;
  const inicio = Date.now();

  req.on('close', () => {
    cancelado = true;
    if (browser) browser.close().catch(() => {});
  });

  try {
    let paginasNestaRodada = 0;
    let motivoParada = null; // 'tempo' | 'limiteGlobal' | null (fila esvaziou = fim natural)

    browser = await lancarNavegador();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    while (filaUrls.length > 0 && !cancelado) {
      if (Date.now() - inicio > DURACAO_MAXIMA_MS) {
        motivoParada = 'tempo';
        break;
      }
      if (totalPaginasAcumulado + paginasNestaRodada >= limiteGlobalPaginas) {
        motivoParada = 'limiteGlobal';
        break;
      }

      const urlAtual = filaUrls.shift();
      paginasNestaRodada++;

      enviar({
        tipo: 'status',
        mensagem: `Vasculhando página ${totalPaginasAcumulado + paginasNestaRodada}...`,
        urlScan: urlAtual,
        fila: filaUrls.length,
      });

      try {
        await page.goto(urlAtual, { waitUntil: 'networkidle2', timeout: TIMEOUT_PAGINA_MS });
        const html = await page.content();
        const $ = cheerio.load(html);

        const processarArquivo = (novoItem) => {
          const chave = hashCurto(JSON.stringify(novoItem));
          if (!encontradosHashes.has(chave)) {
            encontradosHashes.add(chave);
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
              const chaveUrl = hashCurto(novaUrl);

              if (novaUrlObj.hostname === dominioAlvo && !visitadosHashes.has(chaveUrl)) {
                visitadosHashes.add(chaveUrl);
                filaUrls.push(novaUrl);
              }
            }
          } catch (e) {}
        });
      } catch (erroPagina) {
        // ignora página com erro/timeout e segue para a próxima da fila
      }
    }

    const totalPaginasFinal = totalPaginasAcumulado + paginasNestaRodada;

    if (cancelado) {
      // cliente desconectou (abort/fechou a aba) — nada a enviar
    } else if (motivoParada === 'tempo' && filaUrls.length > 0) {
      // Ainda há páginas na fila, mas o tempo desta invocação acabou: manda
      // o estado compactado para o cliente encadear a próxima rodada.
      enviar({
        tipo: 'continuar',
        totalPaginas: totalPaginasFinal,
        estado: {
          filaUrls,
          visitadosHashes: Array.from(visitadosHashes),
          encontradosHashes: Array.from(encontradosHashes),
          totalPaginas: totalPaginasFinal,
        },
      });
      res.end();
    } else {
      // Fila esvaziou (busca realmente terminou) ou bateu no limite global.
      enviar({
        tipo: 'fim',
        totalArquivos: encontradosHashes.size,
        totalPaginas: totalPaginasFinal,
        limiteAtingido: motivoParada === 'limiteGlobal',
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
