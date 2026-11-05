import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { criarServidorHttp } from './http.mjs';
import { salas, politica } from './dados.mjs';

const SEGREDO_HEX = /^[0-9a-f]{64,}$/i;

function exigirSegredo() {
  const segredo = process.env.REQUEST_STATE_SECRET ?? '';
  if (!SEGREDO_HEX.test(segredo) || segredo.length % 2 !== 0) {
    process.stderr.write('REQUEST_STATE_SECRET ausente ou invalido: precisa ser hex com no minimo 32 bytes (64 caracteres)\n');
    process.exit(1);
  }
}

const saidaListarSalas = fromJsonSchema({
  type: 'object',
  title: 'ListaDeSalas',
  properties: {
    salas: {
      type: 'array',
      title: 'Salas',
      items: {
        type: 'object',
        title: 'SalaOut',
        properties: {
          id: { type: 'string', title: 'Id' },
          nome: { type: 'string', title: 'Nome' },
          capacidade: { type: 'integer', title: 'Capacidade' },
          recursos: { type: 'array', title: 'Recursos', items: { type: 'string' } },
        },
        required: ['id', 'nome', 'capacidade', 'recursos'],
      },
    },
  },
  required: ['salas'],
});

const semArgumentos = fromJsonSchema({ type: 'object', title: 'listar_salasArguments', properties: {} });

function criarServidor() {
  const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' });

  server.registerTool(
    'listar_salas',
    { description: 'Lista todas as salas com capacidade e recursos.', inputSchema: semArgumentos, outputSchema: saidaListarSalas },
    async () => {
      const resultado = { salas };
      return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }], structuredContent: resultado };
    },
  );

  server.registerResource('politica', 'politica://uso', { mimeType: 'text/markdown', description: 'Politica de uso das salas.' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: politica }],
  }));

  return server;
}

exigirSegredo();

const porta = Number(process.env.MCP_PORT ?? 7301);
const handler = createMcpHandler(criarServidor, { legacy: 'reject', responseMode: 'json' });
criarServidorHttp(handler).listen(porta, () => {
  process.stderr.write(`servidor MCP em http://localhost:${porta}/mcp\n`);
});
