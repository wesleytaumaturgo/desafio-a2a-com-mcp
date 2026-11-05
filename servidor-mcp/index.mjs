import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { criarServidorHttp } from './http.mjs';
import { salas, politica } from './dados.mjs';
import { consultarDisponibilidade } from './regras.mjs';
import { criarCodec, tratarReserva } from './mrtr.mjs';

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

const campoTexto = (titulo) => ({ type: 'string', title: titulo });
const campoOpcional = (titulo) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: titulo });

const entradaIntervalo = {
  sala: campoTexto('Sala'),
  inicio: campoTexto('Inicio'),
  fim: campoTexto('Fim'),
};

const entradaConsulta = fromJsonSchema({
  type: 'object',
  title: 'consultar_disponibilidadeArguments',
  properties: entradaIntervalo,
  required: ['sala', 'inicio', 'fim'],
});

const entradaReserva = fromJsonSchema({
  type: 'object',
  title: 'reservar_salaArguments',
  properties: { ...entradaIntervalo, responsavel: campoTexto('Responsavel') },
  required: ['sala', 'inicio', 'fim', 'responsavel'],
});

const saidaDisponibilidade = fromJsonSchema({
  type: 'object',
  title: 'Disponibilidade',
  properties: {
    sala: campoTexto('Sala'),
    livre: { type: 'boolean', title: 'Livre' },
    conflitos: {
      type: 'array',
      title: 'Conflitos',
      items: {
        type: 'object',
        title: 'ConflitoOut',
        properties: { id: campoTexto('Id'), inicio: campoTexto('Inicio'), fim: campoTexto('Fim'), responsavel: campoTexto('Responsavel') },
        required: ['id', 'inicio', 'fim', 'responsavel'],
      },
    },
  },
  required: ['sala', 'livre', 'conflitos'],
});

// Com outputSchema o SDK exige structuredContent fora de isError: os campos aceitam null, como no wire 01.
const saidaReserva = fromJsonSchema({
  type: 'object',
  title: 'ReservaOut',
  properties: {
    reserva: campoOpcional('Reserva'),
    reservado: { type: 'boolean', default: true, title: 'Reservado' },
    sala: campoOpcional('Sala'),
    inicio: campoOpcional('Inicio'),
    fim: campoOpcional('Fim'),
    responsavel: campoOpcional('Responsavel'),
    politica: campoOpcional('Politica'),
    motivo: campoOpcional('Motivo'),
  },
});

const comoErro = (texto) => ({ content: [{ type: 'text', text: texto }], isError: true });
const comoResultado = (estruturado) => ({ content: [{ type: 'text', text: JSON.stringify(estruturado, null, 2) }], structuredContent: estruturado });

function criarServidor() {
  const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' }, { requestState: { verify: codec.verify } });

  server.registerTool(
    'listar_salas',
    { description: 'Lista todas as salas com capacidade e recursos.', inputSchema: semArgumentos, outputSchema: saidaListarSalas },
    async () => {
      const resultado = { salas };
      return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }], structuredContent: resultado };
    },
  );

  server.registerTool(
    'consultar_disponibilidade',
    { description: 'Diz se uma sala esta livre no intervalo, e quais reservas conflitam.', inputSchema: entradaConsulta, outputSchema: saidaDisponibilidade },
    async (args) => {
      const { erro, disponibilidade } = consultarDisponibilidade(args);
      return erro ? comoErro(erro) : comoResultado(disponibilidade);
    },
  );

  server.registerTool(
    'reservar_sala',
    { description: 'Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.', inputSchema: entradaReserva, outputSchema: saidaReserva },
    async (args, ctx) => {
      const { erro, resultado, pedido } = await tratarReserva(args, ctx, codec);
      if (erro) return comoErro(erro);
      return pedido ?? comoResultado(resultado);
    },
  );

  server.registerResource('politica', 'politica://uso', { mimeType: 'text/markdown', description: 'Politica de uso das salas.' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: politica }],
  }));

  return server;
}

exigirSegredo();
const codec = criarCodec(process.env.REQUEST_STATE_SECRET);

const porta = Number(process.env.MCP_PORT ?? 7301);
const handler = createMcpHandler(criarServidor, { legacy: 'reject', responseMode: 'json' });
criarServidorHttp(handler).listen(porta, () => {
  process.stderr.write(`servidor MCP em http://localhost:${porta}/mcp\n`);
});
