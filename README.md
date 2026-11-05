# A Ponte: um agente A2A com MCP por dentro

Dois processos Node separados que falam por HTTP:

- `servidor-mcp/`: servidor MCP Streamable HTTP em `http://localhost:7301/mcp` (env `MCP_PORT`), stateless. Tools `listar_salas`, `consultar_disponibilidade` e `reservar_sala`; resource `politica://uso`; MRTR (`input_required` + `requestState` assinado) na reserva.
- `agente/`: por dentro é host MCP (cliente JSON-RPC cru do servidor acima); por fora é servidor A2A v1.0 JSON-RPC em `http://localhost:7300/a2a` (env `AGENTE_PORT`), com o card em `/.well-known/agent-card.json`.

Sem LLM e sem SDK de provedor de LLM em nenhum caminho de execução.

## Como rodar

Requisitos: Node 20 ou superior e Python 3.10 ou superior (só para o validador).

1. Instalar as dependências, que têm versão exata no `package.json`:

   ```bash
   npm ci
   ```

2. Gerar o segredo do `requestState` e exportá-lo no terminal. O valor nunca vai para arquivo nem para o repositório; o servidor exige 64 ou mais caracteres hexadecimais (32 bytes) e sai com código 1 sem ele:

   ```bash
   export REQUEST_STATE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   ```

3. Subir os dois processos, cada um em um terminal, com o mesmo segredo exportado. Deixe o stderr do servidor MCP visível: é nele que está o log de cada request.

   ```bash
   npm run start:mcp
   npm run start:agente
   ```

4. Rodar o validador do starter contra os dois processos:

   ```bash
   python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
   ```

   O validador exige os dois processos recém-iniciados. Se já rodou uma vez, derrube e suba de novo antes de repetir.

5. Atalho que faz os passos 2 a 4 sozinho (gera um segredo aleatório, sobe os dois processos, espera as portas, roda o validador, derruba tudo e sai com o código do validador):

   ```bash
   bash scripts/validar.sh
   ```

   Com um argumento, grava também a saída no arquivo: `bash scripts/validar.sh <arquivo>`. O stderr do servidor MCP fica em `_local/mcp.stderr.log`.

6. Passos manuais do fluxo do avaliador (`curl` do card, `SendMessage` e `GetTask`, `requestState` adulterado, retry depois de restart): reinicie os dois processos antes, porque o validador já consumiu o estado do servidor e das Tasks. `bash scripts/fluxo-avaliador.sh [pasta]` reproduz esses passos e grava um `passo-NN.txt` por passo (padrão `_local/evidencias/`).

7. Testes: `npm test` (equivale a `node --test`).

## Onde a ponte acontece

Tudo está em `agente/ponte.mjs`. É a única parte do agente que enxerga os dois protocolos ao mesmo tempo:

- `agente/ponte.mjs:32`: o resultado da tool vem com `resultType === 'input_required'`. O agente não responde a elicitation por conta própria e não trava esperando; lê a pergunta (`inputRequests` e `requestState`, `agente/ponte.mjs:8-14`) e guarda tudo por `taskId` em `agente/ponte.mjs:39`.
- `agente/ponte.mjs:40`: a Task A2A passa para `TASK_STATE_INPUT_REQUIRED`, com as alternativas na mensagem. O `requestState` e a chave do `inputRequests` ficam só no `Map` da ponte e nunca aparecem em card, artifact, mensagem ou erro A2A.
- `agente/ponte.mjs:76`: quando a continuação chega com `escolha=<sala>`, a ponte repete o `reservar_sala` original com o `requestState` guardado e a resposta em `inputResponses`. O id JSON-RPC do retry é novo: `agente/mcp-cliente.mjs:28` incrementa o contador a cada request, inclusive no retry.
- `agente/ponte.mjs:67`: `escolha=recusar` manda `action: decline` e a Task termina em `TASK_STATE_CANCELED`.

O `traceparent` do cliente A2A é gravado na Task e vai no `_meta` de cada request MCP, com span-id novo. O servidor registra uma linha por request no stderr: `mcp <método> id=<id> traceparent=<valor|->`. Para conferir a ponte, procure no stderr os dois `tools/call` da mesma reserva: o segundo, o retry, tem id diferente do primeiro.

## Decisões técnicas

- **Node 20+, ESM e `@modelcontextprotocol/server` 2.4.0 exato.** Schemas das tools por `fromJsonSchema` com JSON Schema puro, sem `zod` e sem `format` nos campos de data.
- **A2A sem SDK.** Card, `SendMessage` e `GetTask` em `node:http`, com a forma do card igual a `exemplos/wire/07-a2a-agent-card.json`.
- **Agente como cliente MCP cru.** Usa `fetch` com JSON-RPC próprio, sem o cliente do SDK. Esse cliente responderia a elicitation sozinho e a Task nunca pausaria. O agente manda `Accept: application/json, text/event-stream`.
- **`requestState` assinado e sem memória no servidor.** `createRequestStateCodec` do SDK, TTL de 10 minutos, chave vinda de `REQUEST_STATE_SECRET` (hex, 32 bytes ou mais; senão o processo sai com código 1). O payload selado traz sala, início, fim, responsável e alternativas; no retry o servidor usa só o selado e ignora os `arguments`. Não há nonce nem lista de uso único, então o mesmo estado vale depois de restart do servidor.
- **Elicitation sempre com `enum`**, mesmo com uma só alternativa. O agente lê `enum` e `const`.
- **`SendMessage` síncrono.** A resposta já traz o estado final ou a pausa. A Task passa por `SUBMITTED` e `WORKING` no histórico antes disso.
- **Tasks em memória do processo do agente.** Restart do agente perde as Tasks; fora de escopo.
- **Adaptador HTTP próprio no servidor MCP.** `createMcpHandler` devolve um handler web-standard; `servidor-mcp/http.mjs` liga `node:http` a ele e escreve o log antes do handler, para registrar também as rejeições de envelope. As reservas vivem no escopo do módulo `servidor-mcp/regras.mjs`, porque a factory roda a cada request.
- **Regras de sala só no servidor.** Conflito, política e alternativas são do servidor MCP; o agente só traduz protocolo.
- **O kit de trabalho fica fora do entregável.** Nada dele entra no `main` do fork.

## Saída do validador

Saída da última execução de `bash scripts/validar.sh`, com os dois processos recém-iniciados:

```text
trace-id desta execucao: 4c056badabf87897d229ee954761a491
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
