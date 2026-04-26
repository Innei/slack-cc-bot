import Database from 'better-sqlite3';

export type A2AAssignmentTerminalPhase = 'completed' | 'failed' | 'stopped';
export type A2AAssignmentStatus = 'pending' | A2AAssignmentTerminalPhase;
export type A2ASummaryState = 'pending' | 'running' | 'completed';

export interface A2AAssignmentAgentState {
  agentId: string;
  status: A2AAssignmentStatus;
  terminalAt?: string | undefined;
}

export interface A2AAssignmentRecord {
  agentStates: A2AAssignmentAgentState[];
  assignmentId: string;
  channelId: string;
  createdAt: string;
  leadId: string;
  leadProviderId: string;
  summaryState: A2ASummaryState;
  threadTs: string;
  triggerTs: string;
  updatedAt: string;
}

export interface A2ACoordinatorStore {
  close?: () => void;
  createAssignment: (input: {
    agentIds: string[];
    channelId: string;
    leadId: string;
    leadProviderId: string;
    threadTs: string;
    triggerTs: string;
  }) => A2AAssignmentRecord;
  findReadySummaryForLead: (leadId: string) => A2AAssignmentRecord | undefined;
  getAssignmentByTrigger: (threadTs: string, triggerTs: string) => A2AAssignmentRecord | undefined;
  markAgentTerminal: (
    assignmentId: string,
    agentId: string,
    status: A2AAssignmentTerminalPhase,
  ) => A2AAssignmentRecord | undefined;
  markSummaryCompleted: (assignmentId: string) => void;
  markSummaryRunning: (assignmentId: string) => A2AAssignmentRecord | undefined;
}

export class SqliteA2ACoordinatorStore implements A2ACoordinatorStore {
  private readonly sqlite: Database.Database;

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS a2a_assignments (
        assignment_id TEXT PRIMARY KEY,
        thread_ts TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        trigger_ts TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        lead_provider_id TEXT NOT NULL,
        agent_states_json TEXT NOT NULL,
        summary_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_a2a_assignments_lead_summary ON a2a_assignments (lead_id, summary_state)',
    );
    this.sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_a2a_assignments_thread_trigger ON a2a_assignments (thread_ts, trigger_ts)',
    );
  }

  close(): void {
    this.sqlite.close();
  }

  createAssignment(input: {
    agentIds: string[];
    channelId: string;
    leadId: string;
    leadProviderId: string;
    threadTs: string;
    triggerTs: string;
  }): A2AAssignmentRecord {
    const assignmentId = `${input.threadTs}:${input.triggerTs}`;
    const existing = this.getAssignment(assignmentId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const agentStates = unique(input.agentIds).map((agentId) => ({
      agentId,
      status: 'pending' as const,
    }));
    this.sqlite
      .prepare(
        `
        INSERT INTO a2a_assignments (
          assignment_id, thread_ts, channel_id, trigger_ts, lead_id, lead_provider_id,
          agent_states_json, summary_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        assignmentId,
        input.threadTs,
        input.channelId,
        input.triggerTs,
        input.leadId,
        input.leadProviderId,
        JSON.stringify(agentStates),
        'pending',
        now,
        now,
      );

    return this.getAssignment(assignmentId)!;
  }

  getAssignmentByTrigger(threadTs: string, triggerTs: string): A2AAssignmentRecord | undefined {
    const row = this.sqlite
      .prepare('SELECT * FROM a2a_assignments WHERE thread_ts = ? AND trigger_ts = ? LIMIT 1')
      .get(threadTs, triggerTs);
    return row ? rowToRecord(row) : undefined;
  }

  markAgentTerminal(
    assignmentId: string,
    agentId: string,
    status: A2AAssignmentTerminalPhase,
  ): A2AAssignmentRecord | undefined {
    const existing = this.getAssignment(assignmentId);
    if (!existing) {
      return undefined;
    }

    const now = new Date().toISOString();
    const nextStates = existing.agentStates.map((state) =>
      state.agentId === agentId
        ? {
            agentId: state.agentId,
            status,
            terminalAt: now,
          }
        : state,
    );
    this.sqlite
      .prepare(
        'UPDATE a2a_assignments SET agent_states_json = ?, updated_at = ? WHERE assignment_id = ?',
      )
      .run(JSON.stringify(nextStates), now, assignmentId);

    return this.getAssignment(assignmentId);
  }

  findReadySummaryForLead(leadId: string): A2AAssignmentRecord | undefined {
    const rows = this.sqlite
      .prepare(
        `
        SELECT * FROM a2a_assignments
        WHERE lead_id = ? AND summary_state = 'pending'
        ORDER BY created_at ASC
      `,
      )
      .all(leadId);

    for (const row of rows) {
      const record = rowToRecord(row);
      if (
        record.agentStates.length > 0 &&
        record.agentStates.every((s) => s.status !== 'pending')
      ) {
        return record;
      }
    }
    return undefined;
  }

  markSummaryRunning(assignmentId: string): A2AAssignmentRecord | undefined {
    const existing = this.getAssignment(assignmentId);
    if (!existing || existing.summaryState !== 'pending') {
      return undefined;
    }

    this.sqlite
      .prepare(
        "UPDATE a2a_assignments SET summary_state = 'running', updated_at = ? WHERE assignment_id = ? AND summary_state = 'pending'",
      )
      .run(new Date().toISOString(), assignmentId);
    return this.getAssignment(assignmentId);
  }

  markSummaryCompleted(assignmentId: string): void {
    this.sqlite
      .prepare(
        "UPDATE a2a_assignments SET summary_state = 'completed', updated_at = ? WHERE assignment_id = ?",
      )
      .run(new Date().toISOString(), assignmentId);
  }

  private getAssignment(assignmentId: string): A2AAssignmentRecord | undefined {
    const row = this.sqlite
      .prepare('SELECT * FROM a2a_assignments WHERE assignment_id = ?')
      .get(assignmentId);
    return row ? rowToRecord(row) : undefined;
  }
}

export class MemoryA2ACoordinatorStore implements A2ACoordinatorStore {
  private readonly records = new Map<string, A2AAssignmentRecord>();

  createAssignment(input: {
    agentIds: string[];
    channelId: string;
    leadId: string;
    leadProviderId: string;
    threadTs: string;
    triggerTs: string;
  }): A2AAssignmentRecord {
    const assignmentId = `${input.threadTs}:${input.triggerTs}`;
    const existing = this.records.get(assignmentId);
    if (existing) {
      return cloneRecord(existing);
    }
    const now = new Date().toISOString();
    const record: A2AAssignmentRecord = {
      agentStates: unique(input.agentIds).map((agentId) => ({ agentId, status: 'pending' })),
      assignmentId,
      channelId: input.channelId,
      createdAt: now,
      leadId: input.leadId,
      leadProviderId: input.leadProviderId,
      summaryState: 'pending',
      threadTs: input.threadTs,
      triggerTs: input.triggerTs,
      updatedAt: now,
    };
    this.records.set(assignmentId, record);
    return cloneRecord(record);
  }

  getAssignmentByTrigger(threadTs: string, triggerTs: string): A2AAssignmentRecord | undefined {
    return [...this.records.values()]
      .map(cloneRecord)
      .find((record) => record.threadTs === threadTs && record.triggerTs === triggerTs);
  }

  markAgentTerminal(
    assignmentId: string,
    agentId: string,
    status: A2AAssignmentTerminalPhase,
  ): A2AAssignmentRecord | undefined {
    const existing = this.records.get(assignmentId);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    existing.agentStates = existing.agentStates.map((state) =>
      state.agentId === agentId ? { agentId, status, terminalAt: now } : state,
    );
    existing.updatedAt = now;
    return cloneRecord(existing);
  }

  findReadySummaryForLead(leadId: string): A2AAssignmentRecord | undefined {
    return [...this.records.values()]
      .filter((record) => record.leadId === leadId && record.summaryState === 'pending')
      .find(
        (record) =>
          record.agentStates.length > 0 &&
          record.agentStates.every((state) => state.status !== 'pending'),
      );
  }

  markSummaryRunning(assignmentId: string): A2AAssignmentRecord | undefined {
    const existing = this.records.get(assignmentId);
    if (!existing || existing.summaryState !== 'pending') {
      return undefined;
    }
    existing.summaryState = 'running';
    existing.updatedAt = new Date().toISOString();
    return cloneRecord(existing);
  }

  markSummaryCompleted(assignmentId: string): void {
    const existing = this.records.get(assignmentId);
    if (!existing) {
      return;
    }
    existing.summaryState = 'completed';
    existing.updatedAt = new Date().toISOString();
  }
}

function rowToRecord(row: unknown): A2AAssignmentRecord {
  const r = row as Record<string, unknown>;
  return {
    agentStates: JSON.parse(String(r.agent_states_json)) as A2AAssignmentAgentState[],
    assignmentId: String(r.assignment_id),
    channelId: String(r.channel_id),
    createdAt: String(r.created_at),
    leadId: String(r.lead_id),
    leadProviderId: String(r.lead_provider_id),
    summaryState: String(r.summary_state) as A2ASummaryState,
    threadTs: String(r.thread_ts),
    triggerTs: String(r.trigger_ts),
    updatedAt: String(r.updated_at),
  };
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.trim() && values.indexOf(value) === index);
}

function cloneRecord(record: A2AAssignmentRecord): A2AAssignmentRecord {
  return {
    ...record,
    agentStates: record.agentStates.map((state) => ({ ...state })),
  };
}
