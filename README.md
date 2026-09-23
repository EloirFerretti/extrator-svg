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
   O `public/index.html` é servido como arquivo estático pela Vercel
   automaticamente e chama essas mesmas rotas — só que via `fetch` com POST
   em vez de `EventSource` (GET), porque a busca agora manda de volta pro
   servidor o estado da continuação a cada rodada (ver item 3).

2. **`puppeteer` completo é grande demais.** Ele baixa um Chromium de ~300 MB,
   e o limite de uma função na Vercel é 250 MB. Troquei para
   `puppeteer-core` (sem navegador embutido) + `@sparticuz/chromium-min`, que
   baixa em runtime um Chromium compilado especificamente para rodar em
   Lambda/Vercel (ver `lib/browser.js`). Em desenvolvimento local, o código usa
   o Chrome/Edge que já está instalado na sua máquina (autodetectado, ou via
   variável de ambiente `CHROME_EXECUTABLE_PATH`).

3. **Funções seriam mortas no meio do crawling.** O `while` original varria o
   site inteiro sem limite de tempo — ótimo num servidor próprio, mas uma
   função na Vercel tem um teto de execução (`maxDuration`, no máximo 300s no
   Hobby). Um site grande nunca terminaria numa chamada só. A solução: o
   crawler roda em **rodadas encadeadas**. Quando o tempo de uma rodada
   acaba, o servidor manda de volta pro navegador a fila de páginas ainda não
   visitadas (compactada em hashes curtos); o navegador então dispara
   automaticamente uma nova requisição continuando exatamente de onde parou,
   e assim por diante até o site inteiro ser vasculhado — sem o usuário
   precisar fazer nada, do ponto de vista dele é uma busca contínua só. Existe
   um limite de segurança GLOBAL de páginas (padrão 3000, teto 20000, ver
   `MAX_PAGINAS_PADRAO`/`MAX_PAGINAS_LIMITE` em `api/extrair-stream.js`) só
   pra evitar rodar pra sempre em sites com espaço de URLs praticamente
   infinito (calendários, filtros combinatórios etc).

## Paginação dos resultados

Os itens continuam chegando em tempo real, mas agora ficam guardados num
array no navegador e só a página atual (30 itens, ver `ITENS_POR_PAGINA` em
`public/index.html`) é desenhada no DOM. Isso evita que a aba do navegador
trave quando o site tem centenas/milhares de arquivos — sem isso, cada item
virava um card novo direto na tela e o navegador acumulava todos de uma vez.
Como os mais recentes aparecem na página 1 (ver "Ordem dos resultados"
abaixo), é ela que atualiza "ao vivo" enquanto a busca roda; se o usuário
navegar para outra página, a busca continua em segundo plano e os controles
de paginação só atualizam a contagem, sem tirar o usuário do lugar.

## Ordem dos resultados

Os arquivos mais recentemente encontrados aparecem nas primeiras páginas; os
mais antigos vão ficando nas últimas. Isso é calculado sem copiar/inverter a
lista inteira a cada item novo (ver `obterItensDaPagina` em
`public/index.html`), então continua rápido mesmo com milhares de arquivos.

## Detecção de duplicados

Cada arquivo encontrado ganha uma "chave de duplicata":
- **SVG embutido** (`inline: true`): hash do próprio conteúdo do SVG — exato,
  já que o conteúdo inteiro já está disponível (não precisa baixar nada).
- **Arquivo linkado** (SVG/PDF/AI/EPS/CDR por URL): nome do arquivo (última
  parte do caminho). É uma heurística — não baixa o arquivo remoto pra
  comparar byte a byte, então dois arquivos diferentes que por acaso têm o
  mesmo nome (ex.: `icon.svg` genérico usado em contextos diferentes) podem
  ser marcados como duplicados sem serem exatamente iguais.

Quando há pelo menos 1 duplicado, aparece um checkbox "Ocultar arquivos
duplicados" acima dos resultados, com a contagem ao lado. Os duplicados
ficam visualmente marcados (borda tracejada + selo "🔁 Duplicado") mesmo
quando não estão ocultos.

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
- **Sites muito grandes terminam com `limiteAtingido: true`:** agora só
  acontece se o limite de segurança GLOBAL de páginas for atingido (padrão
  3000). Aumente `MAX_PAGINAS_PADRAO` (ou mande `maxPages` no corpo do
  primeiro POST) em `api/extrair-stream.js` se precisar de mais.
- **Busca de site grande demora bastante / parece "reconectar" várias
  vezes:** é esperado — cada rodada dura no máximo ~280s (uma invocação da
  função), e o front-end encadeia automaticamente novas rodadas até acabar a
  fila de páginas ou bater no limite global. Um log "[Sistema] Ainda há
  páginas na fila — continuando automaticamente..." aparece no terminal de
  busca a cada troca de rodada. A aba do navegador precisa continuar aberta
  até o fim.
