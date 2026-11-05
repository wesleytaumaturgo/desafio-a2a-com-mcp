#!/usr/bin/env bash
# Reproduz os passos 3 e 5 a 13 do "Fluxo do avaliador" do README e grava passo-NN.txt.
# Uso: bash scripts/fluxo-avaliador.sh [pasta]   (padrao: _local/evidencias)
# Os passos 7 a 13 rodam com os processos reiniciados depois do validador.
set -u

raiz=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$raiz" || exit 1

pasta=${1:-_local/evidencias}
MCP_PORT=${MCP_PORT:-7301}
AGENTE_PORT=${AGENTE_PORT:-7300}
REQUEST_STATE_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
export MCP_PORT AGENTE_PORT REQUEST_STATE_SECRET

URL_CARD="http://127.0.0.1:$AGENTE_PORT/.well-known/agent-card.json"
URL_A2A="http://127.0.0.1:$AGENTE_PORT/a2a"
URL_MCP="http://127.0.0.1:$MCP_PORT/mcp"
TRACE_ID=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
TRACEPARENT="00-$TRACE_ID-00f067aa0ba902b7-01"
INICIO="2026-11-03T14:00:00-03:00"
FIM="2026-11-03T15:00:00-03:00"

mkdir -p "$pasta"
rm -f "$pasta"/passo-{03,0[5-9],1[0-3]}.txt
tmp=$(mktemp -d)
pid_mcp=
pid_agente=
falhas=0

parar_mcp() {
  [ -n "$pid_mcp" ] && kill "$pid_mcp" 2>/dev/null && wait "$pid_mcp" 2>/dev/null
  pid_mcp=
  return 0
}

parar_agente() {
  [ -n "$pid_agente" ] && kill "$pid_agente" 2>/dev/null && wait "$pid_agente" 2>/dev/null
  pid_agente=
  return 0
}

limpar() {
  parar_agente
  parar_mcp
  rm -rf "$tmp"
}
trap limpar EXIT

porta_aberta() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

esperar_porta() {
  local porta=$1 pid=$2 i
  for ((i = 0; i < 300; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "processo saiu antes de abrir a porta $porta" >&2
      return 1
    fi
    porta_aberta "$porta" && return 0
    sleep 0.1
  done
  echo "porta $porta nao abriu em 30s" >&2
  return 1
}

# $1 = arquivo que recebe o stderr do servidor MCP (anexado, para sobreviver ao restart do passo 12)
subir_mcp() {
  if porta_aberta "$MCP_PORT"; then
    echo "porta $MCP_PORT ja esta em uso" >&2
    return 1
  fi
  node servidor-mcp/index.mjs 2>>"$1" &
  pid_mcp=$!
  esperar_porta "$MCP_PORT" "$pid_mcp"
}

subir_agente() {
  if porta_aberta "$AGENTE_PORT"; then
    echo "porta $AGENTE_PORT ja esta em uso" >&2
    return 1
  fi
  node agente/index.mjs 2>>"$tmp/agente.stderr.log" &
  pid_agente=$!
  esperar_porta "$AGENTE_PORT" "$pid_agente"
}

subir_tudo() {
  subir_mcp "$1" && subir_agente
}

arquivo_passo() {
  printf '%s/passo-%s.txt' "$pasta" "$1"
}

# $1 = passo, resto = texto
gravar() {
  printf '%s\n' "${*:2}" >>"$(arquivo_passo "$1")"
}

# $1 = passo, $2 = arquivo JSON
gravar_json() {
  python3 -m json.tool "$2" >>"$(arquivo_passo "$1")" 2>&1 || cat "$2" >>"$(arquivo_passo "$1")"
}

# $1 = passo, $2 = descricao, resto = comando que sai 0 quando confere
conferir() {
  local passo=$1 descricao=$2
  shift 2
  if "$@"; then
    gravar "$passo" "CONFERE: $descricao"
  else
    gravar "$passo" "NAO CONFERE: $descricao"
    falhas=$((falhas + 1))
  fi
}

fim_passo() {
  cat "$(arquivo_passo "$1")"
  echo
}

# $1 = arquivo JSON, $2 = expressao Python sobre d (documento), r (result) e t (result.task)
testar() {
  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
r = d.get("result") if isinstance(d, dict) else None
t = r.get("task", {}) if isinstance(r, dict) else {}
sys.exit(0 if eval(sys.argv[2]) else 1)
' "$1" "$2"
}

# $1 = arquivo JSON, $2 = expressao Python sobre d; imprime o valor
extrair() {
  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))
' "$1" "$2"
}

PY_A2A='
import json, sys, uuid
rid, texto, task = sys.argv[1:4]
mensagem = {"messageId": "msg-" + uuid.uuid4().hex[:12], "role": "ROLE_USER", "parts": [{"text": texto}]}
if task:
    mensagem["taskId"] = task
print(json.dumps({"jsonrpc": "2.0", "id": int(rid), "method": "SendMessage", "params": {"message": mensagem}}))
'

PY_GETTASK='
import json, sys
print(json.dumps({"jsonrpc": "2.0", "id": int(sys.argv[1]), "method": "GetTask", "params": {"id": sys.argv[2]}}))
'

PY_MCP='
import json, sys
rid, estado, escolha, chave, elicitacao, traceparent, sala = sys.argv[1:8]
meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {"name": "fluxo-avaliador", "version": "1.0.0"},
    "io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}}} if elicitacao == "1" else {},
    "traceparent": traceparent,
}
params = {
    "name": "reservar_sala",
    "arguments": {"sala": sala, "inicio": sys.argv[8], "fim": sys.argv[9], "responsavel": "Marty"},
    "_meta": meta,
}
if estado:
    params["requestState"] = estado
if escolha:
    params["inputResponses"] = {chave: {"action": "accept", "content": {"sala": escolha}}}
print(json.dumps({"jsonrpc": "2.0", "id": int(rid), "method": "tools/call", "params": params}))
'

# $1 = id, $2 = texto, $3 = taskId ('' = Task nova), $4 = arquivo de saida
enviar_a2a() {
  curl -sS -X POST "$URL_A2A" -H 'Content-Type: application/json' -H "traceparent: $TRACEPARENT" \
    --data-binary "$(python3 -c "$PY_A2A" "$1" "$2" "$3")" -o "$4"
}

# $1 = id, $2 = taskId, $3 = arquivo de saida
ler_task() {
  curl -sS -X POST "$URL_A2A" -H 'Content-Type: application/json' \
    --data-binary "$(python3 -c "$PY_GETTASK" "$1" "$2")" -o "$3"
}

# $1 = id, $2 = requestState, $3 = escolha, $4 = chave do inputRequests, $5 = 1 com elicitation / 0 sem,
# $6 = arquivo de saida; imprime o status HTTP
chamar_mcp() {
  curl -sS -X POST "$URL_MCP" -o "$6" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/call' -H 'Mcp-Name: reservar_sala' \
    --data-binary "$(python3 -c "$PY_MCP" "$1" "$2" "$3" "$4" "$5" "$TRACEPARENT" sala-garagem "$INICIO" "$FIM")"
}

# ---------- fase A: processos limpos, passo 3 e validador ----------
log_validador="$pasta/mcp-validador.stderr.log"
log_fluxo="$pasta/mcp-fluxo.stderr.log"
: >"$log_validador"
: >"$log_fluxo"

subir_tudo "$log_validador" || exit 1

curl -sS "$URL_CARD" -o "$tmp/card.json"
gravar 03 "passo 03: curl $URL_CARD"
gravar_json 03 "$tmp/card.json"
conferir 03 "interface JSONRPC, protocolVersion 1.0" \
  testar "$tmp/card.json" 'any(i["protocolBinding"] == "JSONRPC" and i["protocolVersion"] == "1.0" for i in d["supportedInterfaces"])'
conferir 03 "skill reservar-sala" \
  testar "$tmp/card.json" 'any(s["id"] == "reservar-sala" for s in d["skills"])'
fim_passo 03

python3 validador/validar.py --agente "http://127.0.0.1:$AGENTE_PORT" --mcp "http://127.0.0.1:$MCP_PORT" >"$tmp/validador.txt" 2>&1
trace_validador=$(sed -n 's/^trace-id desta execucao: //p' "$tmp/validador.txt")

# passo 5: tools/list antes do primeiro tools/call e traceparent do validador no stderr do MCP
gravar 05 "passo 05: stderr do servidor MCP durante o validador ($log_validador)"
primeiro_list=$(grep -n '^mcp tools/list ' "$log_validador" | head -n 1 | cut -d: -f1)
primeiro_call=$(grep -n '^mcp tools/call ' "$log_validador" | head -n 1 | cut -d: -f1)
gravar 05 "trace-id impresso pelo validador: ${trace_validador:-ausente}"
gravar 05 "primeiro tools/list na linha ${primeiro_list:-ausente}; primeiro tools/call na linha ${primeiro_call:-ausente}"
if [ -n "$trace_validador" ]; then
  grep "traceparent=00-$trace_validador-" "$log_validador" | head -n 5 >>"$(arquivo_passo 05)"
fi
conferir 05 "tools/list anterior ao primeiro tools/call" \
  test -n "$primeiro_list" -a -n "$primeiro_call" -a "${primeiro_list:-0}" -lt "${primeiro_call:-0}"
conferir 05 "traceparent do validador presente no stderr do MCP" \
  grep -q "traceparent=00-${trace_validador:-ausente}-" "$log_validador"
fim_passo 05

# ---------- fase B: restart, estado limpo ----------
parar_agente
parar_mcp
subir_tudo "$log_fluxo" || exit 1

# passo 7: SendMessage de sala ocupada
enviar_a2a 1 "reservar sala=sala-garagem inicio=$INICIO fim=$FIM responsavel=Marty" '' "$tmp/p07.json"
task_id=$(extrair "$tmp/p07.json" 'd["result"]["task"]["id"]')
gravar 07 "passo 07: SendMessage sala=sala-garagem 14h-15h em 03/11/2026"
gravar_json 07 "$tmp/p07.json"
conferir 07 "Task em TASK_STATE_INPUT_REQUIRED" \
  testar "$tmp/p07.json" 't["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"'
conferir 07 "alternativas na ordem sala-fusca, sala-mirante" \
  testar "$tmp/p07.json" '"sala-fusca, sala-mirante" in t["status"]["message"]["parts"][0]["text"]'
fim_passo 07

# passo 8: escolha=sala-mirante e GetTask
enviar_a2a 2 "escolha=sala-mirante" "$task_id" "$tmp/p08-send.json"
ler_task 3 "$task_id" "$tmp/p08.json"
gravar 08 "passo 08: escolha=sala-mirante e GetTask"
gravar_json 08 "$tmp/p08.json"
conferir 08 "Task COMPLETED" \
  testar "$tmp/p08.json" 't["status"]["state"] == "TASK_STATE_COMPLETED"'
conferir 08 "artifact reserva em sala-mirante com politica" \
  testar "$tmp/p08.json" '(lambda a: a["sala"] == "sala-mirante" and bool(a.get("politica")))(json.loads(next(x for x in t["artifacts"] if x["name"] == "reserva")["parts"][0]["text"]))'
fim_passo 08

# passo 6: o par de tools/call dessa reserva no stderr, com o id do retry diferente
gravar 06 "passo 06: tools/call do SendMessage dos passos 7 e 8 ($log_fluxo), trace-id $TRACE_ID"
grep "^mcp tools/call .*traceparent=00-$TRACE_ID-" "$log_fluxo" >"$tmp/pares.txt"
cat "$tmp/pares.txt" >>"$(arquivo_passo 06)"
id_inicial=$(sed -n '1s/^mcp tools\/call id=\([^ ]*\) .*/\1/p' "$tmp/pares.txt")
id_retry=$(sed -n '2s/^mcp tools\/call id=\([^ ]*\) .*/\1/p' "$tmp/pares.txt")
gravar 06 "id inicial: ${id_inicial:-ausente}; id do retry: ${id_retry:-ausente}"
conferir 06 "dois tools/call com o mesmo trace-id e ids diferentes" \
  test -n "$id_inicial" -a -n "$id_retry" -a "$id_inicial" != "$id_retry"
fim_passo 06

# passo 9: recusar
enviar_a2a 4 "reservar sala=sala-garagem inicio=$INICIO fim=$FIM responsavel=Marty" '' "$tmp/p09-send.json"
task_recusa=$(extrair "$tmp/p09-send.json" 'd["result"]["task"]["id"]')
enviar_a2a 5 "escolha=recusar" "$task_recusa" "$tmp/p09.json"
gravar 09 "passo 09: pedido repetido e escolha=recusar"
gravar_json 09 "$tmp/p09.json"
conferir 09 "Task em TASK_STATE_CANCELED" \
  testar "$tmp/p09.json" 't["status"]["state"] == "TASK_STATE_CANCELED"'
fim_passo 09

# passo 10: sala inexistente
enviar_a2a 6 "reservar sala=sala-inexistente inicio=$INICIO fim=$FIM responsavel=Marty" '' "$tmp/p10.json"
gravar 10 "passo 10: sala=sala-inexistente"
gravar_json 10 "$tmp/p10.json"
conferir 10 "Task em TASK_STATE_FAILED" \
  testar "$tmp/p10.json" 't["status"]["state"] == "TASK_STATE_FAILED"'
conferir 10 "historico com 'Sala inexistente: sala-inexistente'" \
  testar "$tmp/p10.json" '"Sala inexistente: sala-inexistente" in json.dumps(t["history"])'
fim_passo 10

# passo 11: requestState adulterado direto no servidor MCP
status=$(chamar_mcp 3 '' '' '' 1 "$tmp/p11-conflito.json")
estado=$(extrair "$tmp/p11-conflito.json" 'd["result"]["requestState"]')
chave=$(extrair "$tmp/p11-conflito.json" 'list(d["result"]["inputRequests"])[0]')
adulterado=$(python3 -c 'import sys; s = sys.argv[1]; i = len(s) // 2; print(s[:i] + ("A" if s[i] != "A" else "B") + s[i + 1:])' "$estado")
status_retry=$(chamar_mcp 4 "$adulterado" sala-fusca "$chave" 1 "$tmp/p11.json")
gravar 11 "passo 11: tools/call de conflito (HTTP $status), retry com um caractere do requestState trocado (HTTP $status_retry)"
gravar_json 11 "$tmp/p11.json"
conferir 11 "erro -32602" testar "$tmp/p11.json" 'd["error"]["code"] == -32602'
fim_passo 11

# passo 12: requestState intacto, MCP reiniciado antes do retry
status=$(chamar_mcp 5 '' '' '' 1 "$tmp/p12-conflito.json")
estado=$(extrair "$tmp/p12-conflito.json" 'd["result"]["requestState"]')
chave=$(extrair "$tmp/p12-conflito.json" 'list(d["result"]["inputRequests"])[0]')
parar_mcp
subir_mcp "$log_fluxo" || exit 1
status_retry=$(chamar_mcp 6 "$estado" sala-fusca "$chave" 1 "$tmp/p12.json")
gravar 12 "passo 12: retry depois do restart do servidor MCP (HTTP $status_retry)"
gravar_json 12 "$tmp/p12.json"
conferir 12 "reserva concluida em sala-fusca depois do restart" \
  testar "$tmp/p12.json" 'not r.get("isError") and r["resultType"] == "complete" and r["structuredContent"]["sala"] == "sala-fusca"'
fim_passo 12

# passo 13: sem elicitation nas capabilities
status=$(chamar_mcp 7 '' '' '' 0 "$tmp/p13.json")
gravar 13 "passo 13: tools/call de conflito sem elicitation (HTTP $status)"
gravar_json 13 "$tmp/p13.json"
conferir 13 "erro -32021" testar "$tmp/p13.json" 'd["error"]["code"] == -32021'
conferir 13 "HTTP 400" test "$status" = 400
fim_passo 13

if [ "$falhas" -ne 0 ]; then
  echo "fluxo do avaliador: $falhas conferencia(s) nao bateram (evidencias em $pasta)" >&2
  exit 1
fi
echo "fluxo do avaliador: todas as conferencias bateram (evidencias em $pasta)"
