import { ESTADO } from './tasks.mjs';

export const ESTADO_PAUSADO = 'TASK_STATE_INPUT_REQUIRED';

const PADRAO_ESCOLHA = /^escolha=(\S+)$/;
const RECUSAR = 'recusar';

function lerPausa(resultado) {
  const [chave, pedido] = Object.entries(resultado.inputRequests ?? {})[0] ?? [];
  const campo = pedido?.params?.requestedSchema?.properties?.sala;
  const alternativas = campo?.enum ?? (campo && 'const' in campo ? [campo.const] : []);
  if (!chave || !resultado.requestState || alternativas.length === 0) return undefined;
  return { chave, alternativas, requestState: resultado.requestState };
}

// requestState, chave e enum ficam so aqui, por taskId: nunca entram na visao A2A da Task
export function criarPonte({ mcp, tasks }) {
  const pausas = new Map();

  async function chamar(task, pedido, extras) {
    tasks.transitar(task, ESTADO.WORKING);
    try {
      const resultado = await mcp.chamarTool('reservar_sala', pedido, { traceId: task.traceId, ...extras });
      await concluir(task, pedido, resultado);
    } catch (erro) {
      pausas.delete(task.id);
      tasks.transitar(task, ESTADO.FAILED, erro.message);
    }
  }

  async function concluir(task, pedido, resultado) {
    if (resultado.resultType === 'input_required') {
      const pausa = lerPausa(resultado);
      if (!pausa) {
        pausas.delete(task.id);
        tasks.transitar(task, ESTADO.FAILED, 'Pausa do servidor sem alternativas legiveis');
        return;
      }
      pausas.set(task.id, { ...pausa, pedido });
      tasks.transitar(task, ESTADO_PAUSADO, `alternativas: ${pausa.alternativas.join(', ')}`);
      return;
    }

    pausas.delete(task.id);
    if (resultado.isError) {
      const mensagem = (resultado.content ?? []).map((p) => p.text ?? '').join(' ');
      tasks.transitar(task, ESTADO.FAILED, mensagem);
    } else if (resultado.structuredContent.reservado === false) {
      tasks.transitar(task, ESTADO.CANCELED, 'Reserva recusada.');
    } else {
      const { reserva, sala, inicio, fim, responsavel } = resultado.structuredContent;
      const politica = await mcp.versaoPolitica({ traceId: task.traceId });
      tasks.adicionarArtifact(task, 'reserva', JSON.stringify({ reserva, sala, inicio, fim, responsavel, politica }));
      tasks.transitar(task, ESTADO.COMPLETED, `Reserva ${reserva} confirmada na ${sala}.`);
    }
  }

  return {
    iniciar: (task, pedido) => chamar(task, pedido),

    pausada: (task) => pausas.has(task.id),

    async continuar(task, texto) {
      const pausa = pausas.get(task.id);
      const escolha = PADRAO_ESCOLHA.exec(texto.trim())?.[1];
      if (escolha === RECUSAR) {
        return chamar(task, pausa.pedido, {
          requestState: pausa.requestState,
          inputResponses: { [pausa.chave]: { action: 'decline' } },
        });
      }
      if (!escolha || !pausa.alternativas.includes(escolha)) {
        tasks.transitar(task, ESTADO_PAUSADO, `alternativas: ${pausa.alternativas.join(', ')}`);
        return;
      }
      return chamar(task, pausa.pedido, {
        requestState: pausa.requestState,
        inputResponses: { [pausa.chave]: { action: 'accept', content: { sala: escolha } } },
      });
    },
  };
}
