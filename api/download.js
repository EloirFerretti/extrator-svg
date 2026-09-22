'use strict';

const axios = require('axios');

const MIME_TYPES = {
  pdf: 'application/pdf',
  ai: 'application/postscript',
  eps: 'application/postscript',
  cdr: 'application/cdr',
  svg: 'image/svg+xml',
};

module.exports = async (req, res) => {
  const { url, ext, action } = req.query;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!url) {
    res.status(400).send('URL não fornecida.');
    return;
  }

  // Define se o arquivo vai ser baixado ou apenas visualizado no navegador
  const modoVisualizacao = action === 'view' ? 'inline' : 'attachment';

  try {
    if (url.startsWith('data:image/svg+xml;base64,')) {
      const base64Data = url.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Disposition', `${modoVisualizacao}; filename="vetor_inline.svg"`);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.status(200).send(buffer);
      return;
    }

    const respostaOrigem = await axios.get(url, {
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    let nomeArquivo = url.split('/').pop().split('?')[0];
    if (!nomeArquivo || !nomeArquivo.includes('.')) nomeArquivo = `arquivo.${ext || 'bin'}`;

    try {
      nomeArquivo = decodeURIComponent(nomeArquivo);
    } catch (e) {}
    nomeArquivo = nomeArquivo.replace(/[/\\?%*:|"<>]/g, '-');

    res.setHeader('Content-Disposition', `${modoVisualizacao}; filename="${nomeArquivo}"`);
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');

    respostaOrigem.data.pipe(res);
  } catch (error) {
    console.error(`Erro ao processar arquivo: ${url}`, error.message);
    res.status(500).send('Erro ao abrir o arquivo. O servidor de origem pode estar bloqueando a requisição.');
  }
};
