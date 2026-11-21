# GAPS (internal)

Internal notes for this package. Not required in a public README. Status after the server front of 20/11/2026.

## Servidor (Worker) — implementado neste pacote

1. **Pareamento.** Implementado. DO `DeviceRegistry` (SQLite): códigos de uso único (TTL) e *claim codes* permanentes presos a um `device_id` (reutilizáveis, rotacionáveis/revogáveis no admin), mais hashes de token. `DEVICE_TOKENS` permanece como fallback legado. Contrato de `POST /v1/devices/pair` congelado em `PROTOCOL.md` §2; claim codes são opção admin aditiva. Também há `POST /v1/admin/devices/revoke`.
2. **`tools/token.mjs`.** Não imprime o token. Só `--hash-stdin` (hash no stdout). Entrega do token: pareamento.
3. **Fuso configurável.** Var `TZ` (padrão `UTC`). Textos de relógio em `en` e `pt-BR`. Testes com `America/Sao_Paulo`, `UTC` e `America/New_York`.
4. **Memória.** `MEMORY_ENABLED` (padrão `true`), `MEMORY_REPO` padrão `luciocs/jarvis-memory-demo`, `MEMORY_SECTIONS` configurável. Sem `GITHUB_TOKEN`, leitura por `raw.githubusercontent.com` (ETag, mesmo cache/TTL/filtro/teto). Com token, contents API (repos privados). **O repo de exemplo está público (confirmado 20/11/2026):** leitura sem token via raw.githubusercontent e Contents API retorna HTTP 200. Há teste real (`test/memory-live.ts`) além dos mocks. No `AGENT.md` a memória é um passo normal que o dono pode pular.
5. **Prompt e textos genéricos.** `ASSISTANT_NAME` padrão `Sarandip`, `DEVICE_KIND`, `source` no payload, `user-agent` `sarandip-casa`, prompts em `en` e `pt-BR`.
6. **Conectores.** Webhook aceita qualquer 2xx. `stub` e `off` mantidos. `openai` (OpenAI-compatible) e `anthropic` implementados e testados com fetch mockado. OpenClaw documentado como webhook genérico (sem cliente nativo).
7. **`REPLY_SECRET` + `REPLY_SECRET_PREVIOUS`.** Aceita os dois durante a rotação. Decisão: **por dono** (um Worker), não por aparelho. Documentado em `PROTOCOL.md` e `AGENT.md`.
8. **Como a rotina guarda o `REPLY_SECRET`.** Documentado que o valor nunca vai no texto. **Pendência:** confirmar o mecanismo suportado no Grok Bot para uma *routine* guardar o segredo sem pô-lo nas instruções. Não foi inventado um mecanismo.
9. **`GET /v1/devices/status`.** Autenticado por token do aparelho ou por `ADMIN_TOKEN` + `device_id`. `online` = WS com `hello`.
10. **`wrangler.example.toml`.** Neutro, sem `account_id`, sem URL pessoal, `name` `sarandip-casa`, `ELEVENLABS_VOICE_ID` vazio, `PUBLIC_BASE_URL` vazio (derivado da origem). `wrangler.toml` no `.gitignore`.
11. **Botão Deploy to Cloudflare.** No README, URL placeholder `https://github.com/OWNER/REPO` claramente marcada. Verificação da documentação oficial (20/11/2026) listada no README, inclusive a pendência de expor um `wrangler.toml` no repo público para o botão.
12. **Documentação.** `PROTOCOL.md` e `README.md` em inglês e generalizados. Protocolo `sarandip-ws-1`, com `luva-ws-1` aceito no `hello`. `AGENT.md` atualizado.
13. **Testes.** Pareamento, TZ, `MEMORY_ENABLED`, rotação dupla do `REPLY_SECRET`, status, token não impresso, conectores openai/anthropic, webhook 2xx.

## Firmware — pacote irmão `../sarandip-casa-firmware`

Os 7 itens de firmware foram implementados lá (portal cativo `Sarandip-Setup`, gestos para reabrir o setup e para factory reset (chave de mudo: 5 trocas em 5 s / 10 em 10 s; BOOT: 10 s / 25 s), credenciais atômicas na NVS, pareamento contra o §2 do `PROTOCOL.md`, wake word `okay_nabu` com licença Apache-2.0 verificada, sem OTA). Teste de contrato de pareamento contra cópia local deste servidor: 14/14.

Decisões do Lucio (20/11/2026 22:25): rede de setup aberta; wake word pública padrão `okay_nabu` (substituída às 22:32: padrão `hey_jarvis`, este servidor `WAKE_WORD=hey_jarvis`, `WAKE_DISPLAY=Hey Jarvis`; `okay_nabu` e `hey_mycroft` como alternativas; "Hey Sarandip" é futura); token na NVS sem criptografia, mitigação = revogação no servidor; factory reset 25 s; Adafruit NeoPixel LGPL-3.0 aprovada.

Pendente: medição de heap e teste na placa real (sem flash sem o Lucio).

## Checklist de limpeza (servidor)

- [x] Histórico git novo, sem copiar `.git`.
- [x] Sem `account_id`, sem subdomínio pessoal, sem voice id pessoal, sem `wrangler.toml` real versionado.
- [x] Sem "Iron Man" no código/docs deste pacote. O nome do repo de memória de exemplo permanece como padrão configurável (o conteúdo Marvel/Tony Stark não está neste pacote).
- [x] Nomes genéricos no código (`dev_home01`, `sarandip-casa`). "luva" só como exemplo de aparelho, ou como alias legado do protocolo (`luva-ws-1`) documentado.
- [x] SPDX AGPL-3.0-only no server; Apache-2.0 em `PROTOCOL.md`. `NOTICE` e CLA (`docs/CLA.md`) prontos. Scanner no CI (gitleaks).
- [ ] Botão Deploy: decidir se no repo público entra uma cópia neutra de `wrangler.toml` (ver README).
- [x] `luciocs/jarvis-memory-demo` tornado público pelo Lucio (20/11/2026). Teste real sem token incluído.
- [ ] Confirmar como a rotina do Grok Bot recebe o `REPLY_SECRET` sem texto.
- [ ] Mecanismo de assinatura do CLA (bot) depois que o repo for público.
- [ ] Contacto de segurança definitivo.
- [ ] A PROPOSTA em `arquitetura-casa` (fora deste pacote) ainda cita Wi-Fi "por Bluetooth ou app" no bloco antigo; a decisão vigente é o portal cativo. Atualizar a PROPOSTA é outro trabalho, e este pacote não edita `/workspace/bt-startup`.
- [ ] Publicar só com o ok explícito do Lucio. Nada de push, remote ou repo público feito por esta frente.

## Áudio de boas-vindas (21/11/2026)

Pedido do Lucio (21/11 16:28): áudio de boas-vindas na primeira ligação após o pareamento. Implementado só no servidor (sem mudança de firmware): o pareamento arma, o próximo `hello` dispara via alarme do DO, enviado como resposta tardia (`tts_start`/PCM/`tts_end`). Padrão público: TTS "Boas-vindas ao seu novo Sarandip." (`WELCOME_MODE=tts`). Clipes próprios: `WELCOME_MODE=audio` + `PUT /v1/admin/welcome-audio` (armazenado no DO, privado) ou `WELCOME_AUDIO_URL`. Clipes de terceiros/marcas nunca entram no repositório. Nota de teste: no runtime de testes os frames binários chegam como `Blob`; `test/integration.spec.ts` ainda lê `new Uint8Array(blob)` (comprimento 0), então as checagens de bytes ali são fracas; `test/welcome.spec.ts` lê os bytes corretamente.
