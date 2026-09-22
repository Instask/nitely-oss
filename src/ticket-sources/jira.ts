import { Buffer } from "node:buffer";

import { EnvProviderConnectionStore } from "../providers/env-store.js";
import {
  MissingConnectionError,
  type ProviderConnectionStore,
} from "../providers/types.js";
import type {
  NormalizedLinkedIssue,
  NormalizedTicket,
  NormalizedTicketAttachment,
  NormalizedTicketComment,
} from "./types.js";

export interface JiraTicketReference {
  baseUrl: string;
  key: string;
  url: string;
}

export type JiraTicketFetcher = (
  reference: JiraTicketReference,
) => Promise<NormalizedTicket>;

export interface JiraStatusUpdate {
  summary: string;
  links: Array<{
    label: string;
    url: string;
  }>;
}

export interface JiraStatusPublishResult {
  id?: string;
  url?: string;
}

export type JiraStatusPublisher = (
  reference: JiraTicketReference,
  update: JiraStatusUpdate,
) => Promise<JiraStatusPublishResult>;

export interface JiraClientOptions {
  providerStore?: ProviderConnectionStore;
}

interface JiraRequestContext {
  headers: Record<string, string>;
  hasCredential: boolean;
}

const ticketKeyPattern = /^[A-Z][A-Z0-9_]*-\d+$/;

const JIRA_CREDENTIAL_SETUP_MESSAGE =
  "Jira ticket could not be fetched. Configure NITELY_JIRA_TOKEN or JIRA_API_TOKEN, NITELY_JIRA_EMAIL when Jira Cloud Basic authentication is required, and the Web Console Jira provider connection when appropriate.";

const JIRA_CREDENTIAL_ACCESS_MESSAGE =
  "Jira ticket could not be fetched because configured Jira credentials were rejected, the ticket was not found, or the account does not have access. Update the Jira provider connection and site/email configuration.";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function normalizeJiraBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Jira base URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Jira base URL must not include credentials");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLocalHostname(parsed.hostname))
  ) {
    throw new Error("Jira base URL must use HTTPS outside localhost development");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Jira base URL must not include a query or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function jiraBaseFromBrowseUrl(parsed: URL): string | undefined {
  const match = /^(.*)\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/.exec(
    parsed.pathname,
  );
  if (!match) return undefined;
  parsed.pathname = match[1] || "";
  parsed.search = "";
  parsed.hash = "";
  return normalizeJiraBaseUrl(parsed.toString());
}

export function parseJiraTicketReference(
  value: string,
  configuredBaseUrl?: string,
): JiraTicketReference {
  const input = value.trim();
  if (!input) {
    throw new Error("Jira ticket reference is required");
  }
  const allowedBase = configuredBaseUrl
    ? normalizeJiraBaseUrl(configuredBaseUrl)
    : undefined;
  const upperKey = input.toUpperCase();
  if (ticketKeyPattern.test(upperKey)) {
    if (!allowedBase) {
      throw new Error(
        "a Jira base URL is required for ticket keys; configure NITELY_JIRA_BASE_URL or paste a Jira browse URL",
      );
    }
    return {
      baseUrl: allowedBase,
      key: upperKey,
      url: `${allowedBase}/browse/${upperKey}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Jira ticket reference must be a ticket key or browse URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Jira ticket URL must not include credentials");
  }
  const pathMatch = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/.exec(
    parsed.pathname,
  );
  const baseUrl = jiraBaseFromBrowseUrl(new URL(parsed.toString()));
  if (!pathMatch || !baseUrl) {
    throw new Error("Jira ticket URL must end with /browse/PROJECT-123");
  }
  const key = pathMatch[1]!.toUpperCase();
  if (allowedBase && baseUrl !== allowedBase) {
    throw new Error("Jira ticket URL must match NITELY_JIRA_BASE_URL");
  }
  if (
    !allowedBase &&
    !parsed.hostname.toLowerCase().endsWith(".atlassian.net") &&
    !isLocalHostname(parsed.hostname)
  ) {
    throw new Error(
      "self-hosted Jira ticket URLs require an explicit NITELY_JIRA_BASE_URL",
    );
  }
  return {
    baseUrl,
    key,
    url: `${baseUrl}/browse/${key}`,
  };
}

export async function configuredJiraBaseUrl(
  providerStore: ProviderConnectionStore | undefined,
): Promise<string | undefined> {
  const store = providerStore ?? new EnvProviderConnectionStore();
  const env = await store.resolveEnv();
  const value = normalizeText(env.NITELY_JIRA_BASE_URL);
  return value ? normalizeJiraBaseUrl(value) : undefined;
}

function apiUrl(reference: JiraTicketReference, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${reference.baseUrl}/`).toString();
}

async function jiraRequestContext(
  providerStore: ProviderConnectionStore | undefined,
): Promise<JiraRequestContext> {
  const store = providerStore ?? new EnvProviderConnectionStore();
  const env = await store.resolveEnv();
  let token: string | undefined;
  try {
    const connection = await store.getConnection("jira");
    token = normalizeText(await connection.getAccessToken()) || undefined;
  } catch (error) {
    if (!(error instanceof MissingConnectionError)) throw error;
  }
  const email = normalizeText(env.NITELY_JIRA_EMAIL);
  const authorization = token
    ? email
      ? `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`
      : `Bearer ${token}`
    : undefined;
  return {
    headers: {
      accept: "application/json",
      ...(authorization ? { authorization } : {}),
    },
    hasCredential: Boolean(token),
  };
}

function retryAfter(response: Response): string | undefined {
  const value = response.headers.get("retry-after")?.trim();
  return value && /^[A-Za-z0-9 .,:+-]{1,64}$/.test(value) ? value : undefined;
}

function jiraRequestError(
  response: Response,
  hasCredential: boolean,
  action: "fetch" | "comment",
): Error {
  if (response.status === 429) {
    const after = retryAfter(response);
    return new Error(
      `Jira rate limit exceeded${after ? `; retry after ${after}` : ""}`,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    if (action === "comment") {
      return new Error(
        hasCredential
          ? "Jira status comment failed because configured credentials were rejected, the ticket was not found, or the account cannot add comments."
          : "Jira status comment requires configured Jira credentials with permission to add comments.",
      );
    }
    return new Error(
      hasCredential ? JIRA_CREDENTIAL_ACCESS_MESSAGE : JIRA_CREDENTIAL_SETUP_MESSAGE,
    );
  }
  return new Error(
    action === "comment"
      ? `Jira status comment failed with ${response.status}`
      : `Jira ticket fetch failed with ${response.status}`,
  );
}

function adfNodeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfNodeText).join("");
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  const type = normalizeText(node.type);
  const attrs =
    node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs)
      ? (node.attrs as Record<string, unknown>)
      : {};
  if (type === "text") return typeof node.text === "string" ? node.text : "";
  if (type === "hardBreak") return "\n";
  if (type === "mention") {
    return normalizeText(attrs.text) || normalizeText(attrs.displayName) || "@mention";
  }
  if (type === "emoji") {
    return normalizeText(attrs.text) || normalizeText(attrs.shortName);
  }
  if (type === "inlineCard" || type === "blockCard") {
    return normalizeText(attrs.url);
  }
  const content = adfNodeText(node.content);
  if (
    type === "paragraph" ||
    type === "heading" ||
    type === "codeBlock" ||
    type === "blockquote"
  ) {
    return `${content}\n`;
  }
  if (type === "listItem") {
    return `${content.replace(/\n+$/, "")}\n`;
  }
  return content;
}

export function jiraDocumentToText(value: unknown): string {
  return adfNodeText(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function displayName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return (
    normalizeText(record.displayName) ||
    normalizeText(record.emailAddress) ||
    normalizeText(record.accountId) ||
    undefined
  );
}

async function fetchJiraComments(
  reference: JiraTicketReference,
  context: JiraRequestContext,
): Promise<NormalizedTicketComment[]> {
  const comments: NormalizedTicketComment[] = [];
  let startAt = 0;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      apiUrl(reference, `rest/api/3/issue/${encodeURIComponent(reference.key)}/comment`),
    );
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", "100");
    const response = await fetch(url, {
      headers: context.headers,
      redirect: "manual",
    });
    if (!response.ok) throw jiraRequestError(response, context.hasCredential, "fetch");
    const payload = (await response.json()) as {
      startAt?: unknown;
      maxResults?: unknown;
      total?: unknown;
      comments?: Array<{
        body?: unknown;
        author?: unknown;
        created?: unknown;
        updated?: unknown;
      }>;
    };
    const values = Array.isArray(payload.comments) ? payload.comments : [];
    for (const comment of values) {
      const body = jiraDocumentToText(comment.body);
      if (!body) continue;
      const author = displayName(comment.author);
      comments.push({
        ...(author ? { author } : {}),
        body,
        ...(typeof comment.created === "string"
          ? { createdAt: comment.created }
          : {}),
        ...(typeof comment.updated === "string"
          ? { updatedAt: comment.updated }
          : {}),
      });
    }
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total)
        ? payload.total
        : startAt + values.length;
    if (values.length === 0 || startAt + values.length >= total) break;
    startAt += values.length;
  }
  return comments;
}

function jiraAttachments(value: unknown): NormalizedTicketAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): NormalizedTicketAttachment | undefined => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const record = entry as Record<string, unknown>;
      const filename = normalizeText(record.filename);
      if (!filename) return undefined;
      return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        filename,
        ...(typeof record.mimeType === "string"
          ? { mediaType: record.mimeType }
          : {}),
        ...(typeof record.size === "number" && Number.isFinite(record.size)
          ? { size: record.size }
          : {}),
        ...(typeof record.content === "string" ? { url: record.content } : {}),
      };
    })
    .filter((entry): entry is NormalizedTicketAttachment => entry !== undefined);
}

function jiraLinkedIssues(
  value: unknown,
  reference: JiraTicketReference,
): NormalizedLinkedIssue[] {
  if (!Array.isArray(value)) return [];
  const linked: NormalizedLinkedIssue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type =
      record.type && typeof record.type === "object" && !Array.isArray(record.type)
        ? (record.type as Record<string, unknown>)
        : {};
    const candidate =
      record.outwardIssue &&
      typeof record.outwardIssue === "object" &&
      !Array.isArray(record.outwardIssue)
        ? {
            issue: record.outwardIssue as Record<string, unknown>,
            relationship: normalizeText(type.outward) || normalizeText(type.name),
          }
        : record.inwardIssue &&
            typeof record.inwardIssue === "object" &&
            !Array.isArray(record.inwardIssue)
          ? {
              issue: record.inwardIssue as Record<string, unknown>,
              relationship: normalizeText(type.inward) || normalizeText(type.name),
            }
          : undefined;
    if (!candidate) continue;
    const key = normalizeText(candidate.issue.key).toUpperCase();
    if (!ticketKeyPattern.test(key)) continue;
    const fields =
      candidate.issue.fields &&
      typeof candidate.issue.fields === "object" &&
      !Array.isArray(candidate.issue.fields)
        ? (candidate.issue.fields as Record<string, unknown>)
        : {};
    const status =
      fields.status &&
      typeof fields.status === "object" &&
      !Array.isArray(fields.status)
        ? (fields.status as Record<string, unknown>)
        : {};
    linked.push({
      relationship: candidate.relationship || "linked to",
      key,
      ...(typeof fields.summary === "string" ? { title: fields.summary } : {}),
      ...(typeof status.name === "string" ? { state: status.name } : {}),
      url: `${reference.baseUrl}/browse/${key}`,
    });
  }
  return linked;
}

export async function defaultJiraTicketFetcher(
  reference: JiraTicketReference,
  options: JiraClientOptions = {},
): Promise<NormalizedTicket> {
  const context = await jiraRequestContext(options.providerStore);
  const url = new URL(
    apiUrl(reference, `rest/api/3/issue/${encodeURIComponent(reference.key)}`),
  );
  url.searchParams.set(
    "fields",
    [
      "summary",
      "description",
      "attachment",
      "labels",
      "status",
      "assignee",
      "reporter",
      "creator",
      "issuelinks",
      "updated",
      "fixVersions",
    ].join(","),
  );
  const response = await fetch(url, {
    headers: context.headers,
    redirect: "manual",
  });
  if (!response.ok) throw jiraRequestError(response, context.hasCredential, "fetch");
  const payload = (await response.json()) as {
    key?: unknown;
    fields?: Record<string, unknown>;
  };
  const key = normalizeText(payload.key || reference.key).toUpperCase();
  const fields =
    payload.fields && typeof payload.fields === "object" ? payload.fields : {};
  const title = normalizeText(fields.summary);
  if (!title) throw new Error("Jira ticket response is missing fields.summary");
  const body = jiraDocumentToText(fields.description) || title;
  const status =
    fields.status && typeof fields.status === "object" && !Array.isArray(fields.status)
      ? (fields.status as Record<string, unknown>)
      : {};
  const statusCategory =
    status.statusCategory &&
    typeof status.statusCategory === "object" &&
    !Array.isArray(status.statusCategory)
      ? (status.statusCategory as Record<string, unknown>)
      : {};
  const assignee = displayName(fields.assignee);
  const reporter = displayName(fields.reporter);
  const author = displayName(fields.creator);
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === "string")
    : [];
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions : [];
  const milestone = versions
    .map((version) =>
      version && typeof version === "object" && !Array.isArray(version)
        ? normalizeText((version as Record<string, unknown>).name)
        : "",
    )
    .filter(Boolean)
    .join(", ");
  const comments = await fetchJiraComments(reference, context);
  const attachments = jiraAttachments(fields.attachment);
  const linkedIssues = jiraLinkedIssues(fields.issuelinks, reference);
  return {
    sourceType: "jira-ticket",
    externalId: ticketKeyPattern.test(key) ? key : reference.key,
    title,
    body,
    url: `${reference.baseUrl}/browse/${ticketKeyPattern.test(key) ? key : reference.key}`,
    ...(typeof status.name === "string" ? { state: status.name } : {}),
    ...(typeof statusCategory.key === "string"
      ? { stateCategory: statusCategory.key }
      : {}),
    ...(typeof fields.updated === "string" ? { updatedAt: fields.updated } : {}),
    ...(author ? { author } : {}),
    ...(reporter ? { reporter } : {}),
    ...(assignee ? { assignees: [assignee] } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(milestone ? { milestone } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(linkedIssues.length > 0 ? { linkedIssues } : {}),
  };
}

function jiraStatusDocument(update: JiraStatusUpdate): Record<string, unknown> {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: update.summary }],
      },
      ...update.links.map((link) => ({
        type: "paragraph",
        content: [
          { type: "text", text: `${link.label}: ` },
          {
            type: "text",
            text: link.url,
            marks: [{ type: "link", attrs: { href: link.url } }],
          },
        ],
      })),
    ],
  };
}

export async function defaultJiraStatusPublisher(
  reference: JiraTicketReference,
  update: JiraStatusUpdate,
  options: JiraClientOptions = {},
): Promise<JiraStatusPublishResult> {
  const context = await jiraRequestContext(options.providerStore);
  const response = await fetch(
    apiUrl(reference, `rest/api/3/issue/${encodeURIComponent(reference.key)}/comment`),
    {
      method: "POST",
      headers: { ...context.headers, "content-type": "application/json" },
      body: JSON.stringify({ body: jiraStatusDocument(update) }),
      redirect: "manual",
    },
  );
  if (!response.ok) throw jiraRequestError(response, context.hasCredential, "comment");
  const payload = (await response.json()) as { id?: unknown; self?: unknown };
  const id = typeof payload.id === "string" ? payload.id : undefined;
  const url =
    typeof payload.self === "string"
      ? payload.self
      : id
        ? `${reference.url}#comment-${id}`
        : undefined;
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
  };
}
