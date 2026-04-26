import type { AgentTeamsConfig, MentionCoordinationDecision } from './agent-team-routing.js';
import { parseUserMentions } from './agent-team-routing.js';

export interface A2AIdentity {
  userId?: string | undefined;
  userName?: string | undefined;
}

export interface A2AThreadContext {
  lead: string;
  participants: string[];
  teamId?: string | undefined;
}

export type A2AThreadReplyDecision =
  | {
      action: 'run';
      reason: 'a2a_explicit_self_mention' | 'a2a_lead_default';
    }
  | {
      action: 'standby';
      lead: string;
      reason:
        | 'a2a_explicit_other_agent_mention'
        | 'a2a_non_lead_default'
        | 'a2a_unmatched_participant';
    };

export function buildA2AThreadContext(
  messageText: string,
  decision: MentionCoordinationDecision,
  agentTeams: AgentTeamsConfig | undefined,
): A2AThreadContext | undefined {
  if (decision.action === 'none') {
    return undefined;
  }

  const participants = new Set<string>();
  if (decision.lead) {
    participants.add(decision.lead);
  }

  if (decision.teamId) {
    const team = agentTeams?.[decision.teamId];
    if (team?.defaultLead) {
      participants.add(team.defaultLead);
    }
    for (const member of team?.members ?? []) {
      participants.add(member);
    }
  }

  for (const mention of parseUserMentions(getRoutingText(messageText))) {
    participants.add(mention);
  }

  return {
    lead: decision.lead,
    participants: [...participants],
    ...(decision.teamId ? { teamId: decision.teamId } : {}),
  };
}

export function serializeA2AParticipants(participants: string[]): string {
  return JSON.stringify(unique(participants));
}

export function parseA2AParticipants(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export function getMentionedA2AParticipants(
  messageText: string,
  context: A2AThreadContext,
): string[] {
  return parseUserMentions(getRoutingText(messageText)).filter((mention) =>
    context.participants.some((participant) => candidateMatchesParticipant(mention, participant)),
  );
}

export function getA2AContextFromSession(session: {
  a2aLead?: string | undefined;
  a2aParticipantsJson?: string | undefined;
  a2aTeamId?: string | undefined;
  conversationMode?: string | undefined;
}): A2AThreadContext | undefined {
  if (session.conversationMode !== 'a2a' || !session.a2aLead) {
    return undefined;
  }
  return {
    lead: session.a2aLead,
    participants: unique([session.a2aLead, ...parseA2AParticipants(session.a2aParticipantsJson)]),
    ...(session.a2aTeamId ? { teamId: session.a2aTeamId } : {}),
  };
}

export function resolveA2AThreadReplyDecision(
  messageText: string,
  identity: A2AIdentity,
  context: A2AThreadContext,
): A2AThreadReplyDecision {
  if (!isA2AParticipant(identity, context)) {
    return {
      action: 'standby',
      lead: context.lead,
      reason: 'a2a_unmatched_participant',
    };
  }

  const mentionedParticipants = parseUserMentions(getRoutingText(messageText)).filter((mention) =>
    context.participants.some((participant) => candidateMatchesParticipant(mention, participant)),
  );

  if (mentionedParticipants.length > 0) {
    if (mentionedParticipants.length > 1 && candidateMatchesIdentity(identity, context.lead)) {
      return { action: 'run', reason: 'a2a_lead_default' };
    }
    const mentionsCurrentBot = mentionedParticipants.some((mention) =>
      candidateMatchesIdentity(identity, mention),
    );
    if (mentionsCurrentBot) {
      return { action: 'run', reason: 'a2a_explicit_self_mention' };
    }
    return {
      action: 'standby',
      lead: context.lead,
      reason: 'a2a_explicit_other_agent_mention',
    };
  }

  if (candidateMatchesIdentity(identity, context.lead)) {
    return { action: 'run', reason: 'a2a_lead_default' };
  }

  return {
    action: 'standby',
    lead: context.lead,
    reason: 'a2a_non_lead_default',
  };
}

export function isA2AParticipant(identity: A2AIdentity, context: A2AThreadContext): boolean {
  if (candidateMatchesIdentity(identity, context.lead)) {
    return true;
  }
  return context.participants.some((participant) =>
    candidateMatchesIdentity(identity, participant),
  );
}

export function identityMatchesA2AParticipant(
  identity: A2AIdentity,
  participant: string | undefined,
): boolean {
  return candidateMatchesIdentity(identity, participant);
}

function candidateMatchesIdentity(identity: A2AIdentity, candidate: string | undefined): boolean {
  return (
    candidateMatchesParticipant(identity.userId, candidate) ||
    candidateMatchesParticipant(identity.userName, candidate)
  );
}

function candidateMatchesParticipant(
  participant: string | undefined,
  candidate: string | undefined,
): boolean {
  if (!participant || !candidate) {
    return false;
  }
  return normalizeParticipant(participant) === normalizeParticipant(candidate);
}

function normalizeParticipant(value: string): string {
  return value.trim().replace(/^@/u, '').toLowerCase();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeParticipant(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function getRoutingText(messageText: string): string {
  return (
    messageText
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}
