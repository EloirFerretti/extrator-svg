# Extrator Multi-Arquivos — versão Vercel

Adaptação do app original (Express + Puppeteer rodando como servidor único) para
rodar como **Vercel Functions** (serverless).

## O que mudou em relação ao original

O app original era um servidor Express de longa duração (`server.js`) com
`puppeteer` completo (baixa ~300 MB de Chromium) e `cors`. Isso **não funciona
direto** na Vercel por três motivos, e foi isso que foi adaptado:

1. **Sem servidor persistente.** A Vercel roda cada rota como uma função que
   liga, responde e desliga. O `server.js` único virou duas funções em `/api`:
   - `api/extrair-stream.js` — o crawler (SSE), antes em `/api/extrair-stream`.
   - `api/download.js` — o proxy de download/visualização, antes em `/api/download`.
   O `public/index.html` continua igual (é servido como arquivo estático pela
   Vercel automaticamente) e chama exatamente as mesmas URLs de antes.

2. **`puppeteer` completo é grande demais.** Ele baixa um Chromium de ~300 MB,
   e o limite de uma função na Vercel é 250 MB. Troquei para
   `puppeteer-core` (sem navegador embutido) + `@sparticuz/chromium-min`, que
   baixa em runtime um Chromium compilado especificamente para rodar em
   Lambda/Vercel (ver `lib/browser.js`). Em desenvolvimento local, o código usa
   o Chrome/Edge que já está instalado na sua máquina (autodetectado, ou via
   variável de ambiente `CHROME_EXECUTABLE_PATH`).

3. **Funções seriam mortas no meio do crawling.** O `while` original varria o
   site inteiro sem limite de tempo — ótimo num servidor próprio, perigoso numa
   função serverless com tempo máximo de execução. Agora o crawler:
   - para sozinho ~20s antes do limite configurado (`maxDuration: 300` em
     `vercel.json`), fechando o navegador e avisando o front-end (`limiteAtingido: true`)
     em vez de ser morto no meio;
   - tem um limite de páginas por busca (padrão 40, configurável via
     `?maxPages=` na URL da API, teto de 150) para não rodar indefinidamente em
     sites muito grandes.

## Deploy

### Opção A — pelo painel da Vercel
1. Suba esta pasta para um repositório no GitHub/GitLab/Bitbucket.
2. Em [vercel.com/new](https://vercel.com/new), importe o repositório.
3. Framework Preset: **Other**. Não precisa de build command nem env vars para
   funcionar no básico. Clique em Deploy.

### Opção B — pela CLI
```bash
npm i -g vercel
cd extrator-svg
vercel        # cria um preview
vercel --prod # publica em produção
```

## Rodando localmente

```bash
npm install
npm run dev   # roda `vercel dev`, que emula as functions localmente
```

Isso vai usar o Chrome/Edge instalado na sua máquina (não baixa nada). Se o
app não encontrar seu navegador automaticamente, defina:

```bash
# macOS, exemplo
export CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Windows (PowerShell), exemplo
$env:CHROME_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
# Linux, exemplo
export CHROME_EXECUTABLE_PATH="/usr/bin/google-chrome"
```

## Variáveis de ambiente (opcionais)

| Variável | Para quê serve |
|---|---|
| `CHROME_EXECUTABLE_PATH` | Caminho de um Chrome/Chromium/Edge específico (local ou até em produção, se você quiser forçar). |
| `CHROMIUM_PACK_URL` | Sobrescreve a URL do pacote do Chromium usado em produção (`@sparticuz/chromium-min`). Útil se você preferir hospedar sua própria cópia em vez de baixar do GitHub Releases do Sparticuz (veja "Deixar mais robusto" abaixo). |

## Limites do plano Vercel a ter em mente

- **Hobby (grátis):** até 300s de duração por função e 2 GB de memória (com
  Fluid Compute, que já vem ligado por padrão). É o que está configurado aqui.
- **Pro:** duração configurável até 800s (ou 1800s no modo estendido) e até
  4 GB de memória, se precisar vasculhar sites bem grandes.
- Ajuste `maxDuration`/`memory` em `vercel.json` conforme seu plano.

## Deixar mais robusto (opcional)

O `@sparticuz/chromium-min` baixa o Chromium de um link hospedado pelo próprio
mantenedor do pacote no GitHub Releases. Isso funciona bem, mas depende de um
serviço de terceiros ficar no ar. Se quiser eliminar essa dependência:

1. Instale `@sparticuz/chromium` (a versão completa) como dependência de
   desenvolvimento.
2. Crie um script `postinstall` que copie o binário comprimido de
   `node_modules/@sparticuz/chromium/bin` para dentro de `public/` do seu
   projeto (assim ele é publicado junto com o site).
3. Aponte `CHROMIUM_PACK_URL` para a URL pública desse arquivo no seu próprio
   domínio (`https://seu-projeto.vercel.app/chromium-pack.tar`).

## Troubleshooting

- **"Chrome/Chromium não encontrado neste ambiente local"** ao rodar
  `npm run dev`: defina `CHROME_EXECUTABLE_PATH` (veja acima).
- **Erro ao lançar o navegador em produção / função muito lenta no cold
  start:** o primeiro request depois de um tempo sem uso baixa e extrai o
  Chromium (~50 MB), o que pode levar alguns segundos a mais. Chamadas
  seguintes são mais rápidas enquanto a função continuar "quente".
- **Chromium/puppeteer-core param de funcionar depois de uma atualização:**
  o `@sparticuz/chromium(-min)` não segue versionamento semântico — qualquer
  patch pode ser incompatível com a versão anterior. As versões estão fixadas
  (sem `^`) em `package.json`/`lib/browser.js` de propósito; se for atualizar,
  atualize `CHROMIUM_MIN_VERSION`/`PACOTE_CHROMIUM_URL` em `lib/browser.js` e a
  versão do pacote em `package.json` juntas, e teste antes de ir para produção.
- **Sites muito grandes terminam com `limiteAtingido: true`:** é esperado —
  aumente `maxPages` na URL da API e/ou o `maxDuration` em `vercel.json`
  (dentro do limite do seu plano).
