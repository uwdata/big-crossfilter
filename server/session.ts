import * as PriorityQueue from 'js-priority-queue';

import * as config from '../config';

interface QueueElement {
  index: number;
  value: number;
};

declare type Callback = (request: Init | Preload | Load, results: ResultData) => void;

// This is responsible for keeping the priority queue,
// rate limiting requests, and watching the cache.
class Session {

  private queue: PriorityQueue<QueueElement>;
  private queryCount: number = 0;
  private closed: boolean = false;
  private hasUserInteracted: boolean = false;
  private sizes: Sizes = {};
  private _onQuery: Callback;

  constructor(public backend: Backend, public dimensions: View[]) {
  }

  // Set the sizes of the charts and initialize the session.
  public init(request: Init) {
    this.sizes = request.sizes;

    this.queue = new PriorityQueue<QueueElement>({
      initialValues: [],
      comparator: (a: QueueElement, b: QueueElement) => {
        return a.value - b.value;
      }
    });
  }

  public onQuery(cb: Callback) {
    this._onQuery = cb;
  }

  public preload(request: Preload) {
    // TODO
  }

  // Load a particular value immediately.
  public load(request: Load) {
    this.backend
      .query(request)
      .then(this.handleQuery(request))
      .catch(console.error);

    this.hasUserInteracted = true;
  }

  private nextQuery() {
    // TODO
  }

  private handleQuery(request: Load | Preload) {
    return (results: ResultData) => {
      if (this.closed) {
        console.warn('Connection closed.');
        return;
      }

      this.queryCount--;
      if (config.optimizations.preload && this.queryCount < config.database.max_connections - (this.dimensions.length - 1)) {
        this.nextQuery();
      }

      if (this._onQuery) {
        this._onQuery(request, results);
      }
    };
  }

  public close() {
    this.closed = true;
  }
}


export default Session;
