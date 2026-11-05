#!/usr/bin/env bash
# Prova da entrega: sobe MCP e agente limpos, roda o validador do starter e derruba tudo.
# Uso: bash scripts/validar.sh [arquivo]   (com arquivo, grava tambem a saida do validador nele)
set -u

raiz=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$raiz" || exit 1

saida=${1:-}
MCP_PORT=${MCP_PORT:-7301}
AGENTE_PORT=${AGENTE_PORT:-7300}
REQUEST_STATE_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
export MCP_PORT AGENTE_PORT REQUEST_STATE_SECRET

mkdir -p _local
pid_mcp=
pid_agente=

derrubar() {
  local pid
  for pid in "$pid_agente" "$pid_mcp"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  return 0
}
trap derrubar EXIT

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

for porta in "$MCP_PORT" "$AGENTE_PORT"; do
  if porta_aberta "$porta"; then
    echo "porta $porta ja esta em uso: o validador exige processos recem-iniciados" >&2
    exit 1
  fi
done

node servidor-mcp/index.mjs 2>_local/mcp.stderr.log &
pid_mcp=$!
esperar_porta "$MCP_PORT" "$pid_mcp" || exit 1

node agente/index.mjs 2>_local/agente.stderr.log &
pid_agente=$!
esperar_porta "$AGENTE_PORT" "$pid_agente" || exit 1

validar=(python3 validador/validar.py --agente "http://localhost:$AGENTE_PORT" --mcp "http://localhost:$MCP_PORT")

if [ -n "$saida" ]; then
  mkdir -p "$(dirname "$saida")"
  "${validar[@]}" 2>&1 | tee "$saida"
  rc=${PIPESTATUS[0]}
else
  "${validar[@]}"
  rc=$?
fi

exit "$rc"
