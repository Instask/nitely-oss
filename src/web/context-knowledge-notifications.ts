import type { ContextKnowledgeEntry } from "../context-kg/store.js";
import {
  configuredHttpNotificationTargets,
  dispatchNotificationDeliveries,
  type NotificationDeliveryTarget,
} from "./notification-delivery.js";
import {
  listNotifications,
  upsertNotification,
  type NotificationRecord,
} from "./notifications.js";

export async function ensureContextKnowledgeProposalNotification(input: {
  repoPath: string;
  entry: ContextKnowledgeEntry;
  body: string;
  taskId?: string;
  runId?: string;
  deliveryTargets?: NotificationDeliveryTarget[];
  env?: Record<string, string | undefined>;
}): Promise<NotificationRecord> {
  const sourceKey = `context-kg:${input.entry.id}:proposal`;
  const existing = (await listNotifications(input.repoPath)).find(
    (candidate) => candidate.sourceKey === sourceKey,
  );
  const taskId = input.taskId ?? input.entry.source?.taskId;
  const runId = input.runId ?? input.entry.source?.runId;
  const notification =
    existing ??
    (await upsertNotification(input.repoPath, {
      sourceKey,
      type: "review-memory",
      severity: "info",
      title: `Review memory proposal: ${input.entry.title}`,
      body: input.body,
      link: `/context-kg?entry=${encodeURIComponent(input.entry.id)}`,
      proposalId: input.entry.id,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
    }));
  if (notification.status !== "pending") return notification;

  let configuredTargets: NotificationDeliveryTarget[] = [];
  try {
    configuredTargets = configuredHttpNotificationTargets(
      input.env ?? process.env,
    );
  } catch {
    // Invalid optional delivery configuration must not block the proposal.
  }
  await dispatchNotificationDeliveries(input.repoPath, notification, [
    ...(input.deliveryTargets ?? []),
    ...configuredTargets,
  ]);
  return notification;
}
