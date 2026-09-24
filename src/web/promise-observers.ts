export function observePromiseOnce<T>(
  pendingKeys: Set<string>,
  key: string,
  promise: Promise<T>,
  observer: (value: T) => void | Promise<void>,
): boolean {
  if (pendingKeys.has(key)) return false;
  pendingKeys.add(key);
  void promise
    .then(observer)
    .catch(() => {})
    .finally(() => pendingKeys.delete(key));
  return true;
}
