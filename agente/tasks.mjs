import { randomBytes } from 'node:crypto';

export const ESTADO = {
  SUBMITTED: 'TASK_STATE_SUBMITTED',
  WORKING: 'TASK_STATE_WORKING',
  COMPLETED: 'TASK_STATE_COMPLETED',
  FAILED: 'TASK_STATE_FAILED',
  CANCELED: 'TASK_STATE_CANCELED',
  REJECTED: 'TASK_STATE_REJECTED',
};

const TERMINAIS = new Set([ESTADO.COMPLETED, ESTADO.FAILED, ESTADO.CANCELED, ESTADO.REJECTED]);

const novoId = (prefixo) => `${prefixo}-${randomBytes(6).toString('hex')}`;

export function criarTasks() {
  const porId = new Map();

  function mensagemDoAgente(task, texto) {
    return {
      messageId: novoId('msg'),
      role: 'ROLE_AGENT',
      parts: [{ text: texto }],
      taskId: task.id,
      contextId: task.contextId,
    };
  }

  return {
    criar({ mensagem, traceId }) {
      const task = {
        id: novoId('task'),
        contextId: novoId('ctx'),
        estado: ESTADO.SUBMITTED,
        mensagemDeStatus: undefined,
        historico: [mensagem],
        artifacts: [],
        transicoes: [ESTADO.SUBMITTED],
        traceId,
      };
      porId.set(task.id, task);
      return task;
    },

    obter: (id) => porId.get(id),

    terminal: (task) => TERMINAIS.has(task.estado),

    transitar(task, estado, texto) {
      task.estado = estado;
      task.transicoes.push(estado);
      task.mensagemDeStatus = texto === undefined ? undefined : mensagemDoAgente(task, texto);
      if (task.mensagemDeStatus) task.historico.push(task.mensagemDeStatus);
    },

    adicionarArtifact(task, nome, texto) {
      task.artifacts.push({ artifactId: novoId('art'), name: nome, parts: [{ text: texto }] });
    },

    // so o que o protocolo A2A publica; o resto da Task e interno
    visao(task) {
      const status = { state: task.estado };
      if (task.mensagemDeStatus) status.message = task.mensagemDeStatus;
      return {
        id: task.id,
        contextId: task.contextId,
        status,
        history: task.historico,
        artifacts: task.artifacts,
      };
    },
  };
}
