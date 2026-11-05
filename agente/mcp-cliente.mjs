import { randomBytes } from 'node:crypto';

const VERSAO_PROTOCOLO = '2026-07-28';
const URI_POLITICA = 'politica://uso';

export function criarClienteMcp({ url }) {
  let proximoId = 0;
  let toolsListadas = false;
  let nomesAnunciados = new Set();

  async function requisitar(metodo, nome, params, traceId) {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': VERSAO_PROTOCOLO,
      'io.modelcontextprotocol/clientInfo': { name: 'agente-central-de-salas', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
    };
    if (traceId) meta.traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': VERSAO_PROTOCOLO,
      'Mcp-Method': metodo,
    };
    if (nome) headers['Mcp-Name'] = nome;

    // id novo a cada request, inclusive no retry do MRTR: o servidor trata o retry como request distinto
    const id = ++proximoId;
    const resposta = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: metodo, params: { ...params, _meta: meta } }),
    });
    const corpo = await resposta.json();
    if (corpo.error) {
      const erro = new Error(corpo.error.message);
      erro.codigo = corpo.error.code;
      erro.data = corpo.error.data;
      throw erro;
    }
    return corpo.result;
  }

  async function listarTools({ traceId } = {}) {
    const resultado = await requisitar('tools/list', undefined, {}, traceId);
    nomesAnunciados = new Set((resultado.tools ?? []).map((t) => t.name));
    toolsListadas = true;
    return resultado;
  }

  function lerPolitica({ traceId } = {}) {
    return requisitar('resources/read', URI_POLITICA, { uri: URI_POLITICA }, traceId);
  }

  return {
    listarTools,
    lerPolitica,

    async versaoPolitica({ traceId } = {}) {
      const politica = await lerPolitica({ traceId });
      const achado = /^versao:\s*(\S+)/.exec(politica.contents?.[0]?.text ?? '');
      if (!achado) throw new Error('politica sem linha de versao');
      return achado[1];
    },

    async chamarTool(nome, argumentos, { traceId, requestState, inputResponses } = {}) {
      if (!toolsListadas) await listarTools({ traceId });
      if (!nomesAnunciados.has(nome)) throw new Error(`tool nao anunciada: ${nome}`);
      const params = { name: nome, arguments: argumentos };
      if (inputResponses) params.inputResponses = inputResponses;
      if (requestState) params.requestState = requestState;
      return requisitar('tools/call', nome, params, traceId);
    },
  };
}
