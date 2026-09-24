import type { ChangeRequestStatus } from "../scm/types.js";
import type { TaskRecord } from "../web/tasks.js";

export type ChangeRequestStatusFetcher = (
  url: string,
) => Promise<ChangeRequestStatus>;

export type CompletionPredicate = (taskId: string) => boolean;

export async function createCompletionPredicate(
  tasks: TaskRecord[],
  getChangeRequestStatus: ChangeRequestStatusFetcher,
): Promise<CompletionPredicate> {
  const completedById = new Map<string, boolean>();
  const urlCache = new Map<string, Promise<boolean>>();

  await Promise.all(
    tasks.map(async (task) => {
      if (task.status !== "completed" || !task.changeRequestUrl) {
        completedById.set(task.id, false);
        return;
      }
      let check = urlCache.get(task.changeRequestUrl);
      if (!check) {
        check = getChangeRequestStatus(task.changeRequestUrl)
          .then((status) => status.merged === true)
          .catch(() => false);
        urlCache.set(task.changeRequestUrl, check);
      }
      completedById.set(task.id, await check);
    }),
  );

  return (taskId: string) => completedById.get(taskId) === true;
}
