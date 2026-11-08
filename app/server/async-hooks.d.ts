// workerd provides node:async_hooks under the `nodejs_als` flag; only the part we use is typed
// here, so the app does not pull in all of @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
