import { createRequestStateCodec, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { salas } from './dados.mjs';
import { consultarDisponibilidade, reservarSala, ERRO_SEM_ALTERNATIVA } from './regras.mjs';

export const CHAVE_ESCOLHA = 'escolha_de_sala';

const MAXIMO_ALTERNATIVAS = 3;
const MENSAGEM_ESCOLHA = 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';

export const criarCodec = (segredo, ttlSeconds = 600) =>
  createRequestStateCodec({ key: Buffer.from(segredo, 'hex'), ttlSeconds });

const porCapacidadeEId = (a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function alternativasPara({ sala, inicio, fim }) {
  const pedida = salas.find((s) => s.id === sala);
  return salas
    .filter((s) => s.id !== sala && s.capacidade >= pedida.capacidade)
    .filter((s) => consultarDisponibilidade({ sala: s.id, inicio, fim }).disponibilidade?.livre)
    .sort(porCapacidadeEId)
    .slice(0, MAXIMO_ALTERNATIVAS)
    .map((s) => s.id);
}

async function pedirEscolha(codec, selado) {
  const requestedSchema = {
    type: 'object',
    properties: {
      sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: selado.alternativas },
    },
    required: ['sala'],
  };
  return {
    pedido: inputRequired({
      inputRequests: { [CHAVE_ESCOLHA]: inputRequired.elicit({ message: MENSAGEM_ESCOLHA, mode: 'form', requestedSchema }) },
      requestState: await codec.mint(selado),
    }),
  };
}

const semReserva = (motivo) => ({
  resultado: { reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo },
});

// No retry só o estado selado vale: os arguments do request são entrada do cliente e são ignorados.
export async function tratarReserva(args, ctx, codec) {
  const selado = ctx.mcpReq.requestState();

  if (!selado) {
    const { erro, reserva, conflitos } = reservarSala(args);
    if (erro) return { erro };
    if (!conflitos) return { resultado: reserva };
    const { sala, inicio, fim, responsavel } = args;
    const alternativas = alternativasPara(args);
    if (alternativas.length === 0) return { erro: ERRO_SEM_ALTERNATIVA };
    return pedirEscolha(codec, { sala, inicio, fim, responsavel, alternativas });
  }

  const resposta = inputResponse(ctx.mcpReq.inputResponses, CHAVE_ESCOLHA);
  if (resposta.kind === 'elicit' && resposta.action === 'decline') return semReserva('recusado');
  if (resposta.kind === 'elicit' && resposta.action === 'cancel') return semReserva('cancelado');

  const escolhida = resposta.kind === 'elicit' ? resposta.content?.sala : undefined;
  if (!selado.alternativas.includes(escolhida)) return pedirEscolha(codec, selado);

  const { inicio, fim, responsavel } = selado;
  const { reserva, conflitos, erro } = reservarSala({ sala: escolhida, inicio, fim, responsavel });
  if (erro) return { erro };
  if (conflitos) return { erro: ERRO_SEM_ALTERNATIVA };
  return { resultado: reserva };
}
