export type TicketSourceType = "github-issue" | "jira-ticket";

export interface NormalizedTicketComment {
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NormalizedTicketAttachment {
  id?: string;
  filename: string;
  mediaType?: string;
  size?: number;
  url?: string;
}

export interface NormalizedLinkedIssue {
  relationship: string;
  key: string;
  title?: string;
  state?: string;
  url?: string;
}

export interface NormalizedTicket {
  sourceType: TicketSourceType;
  externalId: string;
  title: string;
  body: string;
  url: string;
  state?: string;
  stateCategory?: string;
  updatedAt?: string;
  author?: string;
  reporter?: string;
  assignees?: string[];
  labels?: string[];
  milestone?: string;
  comments?: NormalizedTicketComment[];
  attachments?: NormalizedTicketAttachment[];
  linkedIssues?: NormalizedLinkedIssue[];
}
