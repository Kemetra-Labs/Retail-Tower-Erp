// jsdom has no IntersectionObserver. This stub records its instances so a test
// can report the tile as off-screen or back on screen:
//   fakeObservers().forEach((o) => o.fire(false))
type Callback = (entries: { isIntersecting: boolean }[]) => void;

class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: Callback) {
    registry().push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    const list = registry();
    const at = list.indexOf(this);
    if (at >= 0) list.splice(at, 1);
  }
  takeRecords(): [] {
    return [];
  }
  /** Test helper: deliver an intersection change to the page's callback. */
  fire(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }]);
  }
}

type Holder = { __fakeObservers?: FakeIntersectionObserver[] };
function registry(): FakeIntersectionObserver[] {
  const holder = globalThis as unknown as Holder;
  holder.__fakeObservers ??= [];
  return holder.__fakeObservers;
}

Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: FakeIntersectionObserver,
});
