'use strict';

const cheerio = require('cheerio');
const axios = require('axios');
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

// Quantas checagens de rede (assinatura de SVG / nome+tamanho de arquivo)
// rodam em paralelo por página. Mantém o crawler rápido sem sobrecarregar o
// site de origem.
const CONCORRENCIA_ENRIQUECIMENTO = 5;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Hash curto (FNV-1a) usado tanto pra deduplicar página/arquivo já vistos
// entre rodadas quanto pra gerar a "assinatura" de conteúdo de um SVG.
function hashCurto(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Roda fn(item) para cada item em "itens", no máximo "limite" execuções
// simultâneas, preservando a ordem de processamento apenas por disponibilidade
// (não por índice) — usado pra buscar em paralelo, sem sequência importar.
async function mapComLimite(itens, limite, fn) {
  let indice = 0;
  async function trabalhador() {
    while (indice < itens.length) {
      const i = indice++;
      await fn(itens[i], i);
    }
  }
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador());
  await Promise.all(trabalhadores);
}

// Assinatura de conteúdo de um SVG a partir das tags <path>: concatena o
// atributo "d" de cada <path> (normalizando espaços) e tira um hash. Dois
// SVGs com os mesmos caminhos geram a mesma assinatura mesmo que tenham
// ids/classes/cores diferentes — o que costuma acontecer quando o mesmo
// ícone é reexportado ou embutido de formas ligeiramente diferentes pelo
// site. Retorna null se não achar nenhuma tag <path> (nesse caso o cliente
// cai pro nome do arquivo como heurística de duplicidade).
function assinaturaDoConteudoSvg(conteudoSvg) {
  try {
    const $svg = cheerio.load(conteudoSvg, { xmlMode: true });
    const caminhos = [];
    $svg('path').each((_, el) => {
      const d = $svg(el).attr('d');
      if (d) caminhos.push(d.replace(/\s+/g, ' ').trim());
    });
    if (caminhos.length === 0) return null;
    return hashCurto(caminhos.join('|'));
  } catch (e) {
    return null;
  }
}

// Mesma ideia, mas pra um <svg> já presente no HTML da página (SVG embutido).
function assinaturaDeElementoSvg($, el) {
  const caminhos = [];
  $(el)
    .find('path')
    .each((_, p) => {
      const d = $(p).attr('d');
      if (d) caminhos.push(d.replace(/\s+/g, ' ').trim());
    });
  if (caminhos.length === 0) return null;
  return hashCurto(caminhos.join('|'));
}

function extrairNomeDeContentDisposition(cabecalho) {
  if (!cabecalho) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cabecalho);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (e) {
    return match[1];
  }
}

// Busca informações extras de um arquivo LINKADO (por URL):
//  - SVG: baixa o conteúdo (GET) pra montar a assinatura por <path> e usa o
//    próprio tamanho do conteúdo baixado.
//  - Outros formatos (pdf/ai/eps/cdr): faz um HEAD só pra ler os cabeçalhos
//    Content-Disposition (nome real do arquivo, quando o site informa) e
//    Content-Length (tamanho), sem baixar o arquivo inteiro.
// Falhas de rede (timeout, CORS do lado do servidor, 404, HEAD bloqueado
// etc.) são silenciosas: o item simplesmente fica sem essa informação extra
// e o cliente usa os fallbacks (nome vindo da URL, sem tamanho, dedupe por
// nome de arquivo).
async function enriquecerCandidato(candidato) {
  const resultado = { assinatura: null, nomeArquivo: null, tamanhoBytes: null };

  if (candidato.extensao === 'svg') {
    try {
      const resp = await axios.get(candidato.src, {
        timeout: 6000,
        responseType: 'text',
        maxContentLength: 3 * 1024 * 1024,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT },
      });
      resultado.assinatura = assinaturaDoConteudoSvg(resp.data);
      resultado.tamanhoBytes = Buffer.byteLength(resp.data, 'utf8');
    } catch (e) {
      // sem assinatura/tamanho — segue com os fallbacks do cliente
    }
    return resultado;
  }

  try {
    const resp = await axios.head(candidato.src, {
      timeout: 4000,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT },
    });
    resultado.nomeArquivo = extrairNomeDeContentDisposition(resp.headers['content-disposition']);
    const tamanho = resp.headers['content-length'];
    if (tamanho) resultado.tamanhoBytes = parseInt(tamanho, 10) || null;
  } catch (e) {
    // HEAD pode falhar em alguns servidores — segue sem nome/tamanho extra
  }
  return resultado;
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
    await page.setUserAgent(USER_AGENT);

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

        const itensProntos = [];
        const candidatosLinkados = [];
        const vistosNestaPagina = new Set();

        const adicionarCandidatoLinkado = (extensao, srcAbsoluto) => {
          const chave = extensao + '|' + srcAbsoluto;
          if (vistosNestaPagina.has(chave)) return;
          vistosNestaPagina.add(chave);
          candidatosLinkados.push({ extensao, src: srcAbsoluto });
        };

        if (tiposPermitidos.includes('svg')) {
          $('img').each((_, el) => {
            const src = $(el).attr('src');
            if (src && src.toLowerCase().includes('.svg')) {
              try {
                adicionarCandidatoLinkado('svg', new URL(src, urlAtual).href);
              } catch (e) {}
            }
          });

          $('svg').each((_, el) => {
            $(el).attr('xmlns', 'http://www.w3.org/2000/svg');
            const svgHtml = $.html(el);
            const base64 = Buffer.from(svgHtml).toString('base64');
            itensProntos.push({
              extensao: 'svg',
              src: `data:image/svg+xml;base64,${base64}`,
              inline: true,
              assinatura: assinaturaDeElementoSvg($, el),
              nomeArquivo: null,
              tamanhoBytes: Buffer.byteLength(svgHtml, 'utf8'),
            });
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
              adicionarCandidatoLinkado(extensaoEncontrada, new URL(link, urlAtual).href);
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

        if (candidatosLinkados.length > 0) {
          enviar({
            tipo: 'status',
            mensagem: `Verificando ${candidatosLinkados.length} arquivo(s) desta página (nome, tamanho e duplicidade)...`,
            urlScan: urlAtual,
            fila: filaUrls.length,
          });

          await mapComLimite(candidatosLinkados, CONCORRENCIA_ENRIQUECIMENTO, async (candidato) => {
            const extra = await enriquecerCandidato(candidato);
            itensProntos.push({
              extensao: candidato.extensao,
              src: candidato.src,
              inline: false,
              assinatura: extra.assinatura,
              nomeArquivo: extra.nomeArquivo,
              tamanhoBytes: extra.tamanhoBytes,
            });
          });
        }

        itensProntos.forEach((item) => {
          const chaveGlobal = hashCurto(item.extensao + '|' + item.src);
          if (!encontradosHashes.has(chaveGlobal)) {
            encontradosHashes.add(chaveGlobal);
            const logSrc = item.inline ? 'SVG Embutido (Código Base64)' : item.src;
            enviar({ tipo: 'arquivo', item, logSrc });
          }
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
