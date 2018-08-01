import ndarray from "ndarray";
import { changeset, truthy, View as VgView } from "vega-lib";
import { Logger, View, View1D, View2D, Views } from "./api";
import { Interval } from "./basic";
import { Config, DEFAULT_CONFIG } from "./config";
import { DataBase } from "./db";
import { Cubes } from "./db/db";
import {
  bin,
  binTime,
  binToData,
  chEmd,
  extent,
  numBins,
  omit,
  sub,
  subInterpolated,
  summedAreaTableLookup,
  throttle
} from "./util";
import {
  createBarView,
  createHeatmapView,
  createHistogramView,
  createTextView
} from "./views";
import Premonish from "premonish";
import { select } from "d3-selection";

const width = window.innerWidth;
const height = window.innerHeight;
const svg = select("body")
  .append("svg")
  .attr("width", width)
  .attr("height", height)
  .style("position", "absolute")
  .style("top", 0)
  .style("bottom", 0);

const line = svg
  .append("line")
  .attr("stroke", "rgb(0, 0, 0)")
  .attr("opacity", 0.4)
  .attr("stroke-width", 2);
const circle = svg
  .append("circle")
  .attr("fill", "rgb(0, 0, 0)")
  .attr("opacity", 0.4)
  .attr("r", 10);

let mouseIsDown = false;

document.onmousedown = () => {
  mouseIsDown = true;
};

document.onmouseup = () => {
  mouseIsDown = false;
};

class PendingData<V> {
  private highRes: Cubes<V> | Promise<Cubes<V>>;

  private highResPending = true;

  constructor(
    private lowRes: Cubes<V> | Promise<Cubes<V>>,
    /**
     * Function to request high res data. Can be resolved later.
     */
    private fetchHighRes_: () => Cubes<V> | Promise<Cubes<V>>,
    private highResCallback: (cubes: Cubes<V>) => void
  ) {}

  public fetchHighRes() {
    if (!this.highRes) {
      this.highRes = this.fetchHighRes_();

      const done = cube => {
        this.highResPending = false;
        this.highResCallback(cube);
      };

      if (this.highRes instanceof Promise) {
        this.highRes.then(done);
      } else {
        done(this.highRes);
      }
    }
  }

  public cubes(): Cubes<V> | Promise<Cubes<V>> {
    return this.highResPending ? this.lowRes : this.highRes;
  }
}

export class App<V extends string, D extends string> {
  private readonly views: Views<V, D> = new Map();
  private activeView: V;
  private vegaViews = new Map<V, VgView>();
  private brushes = new Map<D, Interval<number>>();

  /**
   * Data for each non-active view.
   */
  private cubes: Cubes<V>;

  /**
   * Prefetched data that can be moved to data when the active view changes.
   */
  private prefetchedData = new Map<V, PendingData<V>>();

  /**
   * How many required requests are pending for the view;
   */
  private pendingRequests = new Map<V, number>();

  private readonly config: Config;

  private logger?: Logger<V>;

  private readonly highRes1D: number;
  private readonly highRes2D: number;

  private throttledUpdate: () => void;

  /**
   * Track which view was last hovered so we can fetch high resolution data.
   */
  private lastHovered: {
    view: V | null;
    when: number;
  } = { view: null, when: 0 };

  private interactiveElements: HTMLElement[] = [];

  /**
   * Construct the app
   * @param views The views.
   * @param db The database to query.
   * @param opt Optional arguments.
   */
  public constructor(
    views: Views<V, D>,
    private db: DataBase<V, D>,
    opt?: {
      config?: Partial<Config>;
      logger?: Logger<V>;
      cb?: () => void;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...((opt && opt.config) || {}) };
    this.logger = opt && opt.logger;

    this.highRes1D = Math.min(
      this.config.maxInteractiveResolution1D,
      this.config.histogramWidth
    );
    this.highRes2D = Math.min(
      this.config.maxInteractiveResolution2D,
      this.config.heatmapWidth
    );

    this.throttledUpdate = throttle(this.update);

    for (const [name, view] of views) {
      if (view.el) {
        this.views.set(name, view);
      }
    }

    this.initialize()
      .then(() => {
        const premonish = new Premonish({
          elements: this.interactiveElements
        });

        premonish.onMouseMove(({ position, velocity, estimate }) => {
          circle.attr("cx", estimate.x).attr("cy", estimate.y);

          line
            .attr("x1", position.x)
            .attr("y1", position.y)
            .attr("x2", estimate.x)
            .attr("y2", estimate.y);
        });

        premonish.onIntent(({ el, confidence }) => {
          this.prefetchActiveView(el.getAttribute("data-name") as V);
          // console.log(el.getAttribute("data-name")); // The DOM node we suspect the user is about to interact with.
          // console.log(confidence); // How confident are we about the user's intention? Scale 0-1
        });

        console.info("Initialization finished.");
        opt && opt.cb && opt.cb();
      })
      .catch(console.error);
  }

  private async initialize() {
    // initialize the database
    await this.db.initialize();

    await Promise.all(
      Array.from(this.views.entries()).map(([name, view]) =>
        this.initializeView(name, view)
      )
    );
  }

  private async initializeView(name: V, view: View<D>) {
    const el = view.el!;

    el.setAttribute("data-name", name);

    if (view.type === "0D") {
      const vegaView = (this.config.zeroDBar ? createBarView : createTextView)(
        el,
        view
      );
      this.vegaViews.set(name, vegaView);

      this.update0DView(name, await this.db.length(), true);
    } else if (view.type === "1D") {
      const binConfig = (view.dimension.time ? binTime : bin)(
        view.dimension.bins,
        view.dimension.extent
      );
      view.dimension.binConfig = binConfig;

      const vegaView = createHistogramView(
        el,
        view,
        this.config,
        !!this.logger
      );
      this.vegaViews.set(name, vegaView);

      const data = await this.db.histogram(view.dimension);
      this.update1DView(name, view, data, this.config.showBase);

      vegaView.addSignalListener("dataBrush", (_name, value) => {
        this.brushMove1D(name, view.dimension.name, value);
      });

      vegaView.addEventListener("mouseover", () => {
        this.prefetchActiveView(name);
      });

      if (this.config.showInterestingness) {
        vegaView.addSignalListener(
          "brushSingleStart",
          (_name, value: number) => {
            vegaView
              .change(
                "interesting",
                changeset()
                  .remove(truthy)
                  .insert(this.calculateInterestingness({ start: value }))
              )
              .run();
          }
        );

        vegaView.addSignalListener("brushMoveStart", (_name, value: number) => {
          vegaView
            .change(
              "interesting",
              changeset()
                .remove(truthy)
                .insert(this.calculateInterestingness({ window: value }))
            )
            .run();
        });
      }

      if (this.logger) {
        this.logger.attach(name, vegaView);
      }

      this.interactiveElements.push(el);
    } else {
      for (const dimension of view.dimensions) {
        const binConfig = (dimension.time ? binTime : bin)(
          dimension.bins,
          dimension.extent
        );
        dimension.binConfig = binConfig;
      }

      const vegaView = createHeatmapView(el, view, this.config);
      this.vegaViews.set(name, vegaView);

      const data = await this.db.heatmap(view.dimensions);
      this.update2DView(name, view, data, this.config.showBase);

      vegaView.addSignalListener("dataBrush", (_name, value) => {
        this.brushMove2D(
          name,
          view.dimensions[0].name,
          view.dimensions[1].name,
          value
        );
      });

      vegaView.addEventListener("mouseover", () => {
        this.prefetchActiveView(name);
      });

      this.interactiveElements.push(el);
    }
  }

  /**
   * Get data for the view so that we can brush in it.
   */
  private prefetchActiveView(name: V) {
    if (mouseIsDown) {
      return;
    }

    if (this.lastHovered.view !== name) {
      this.lastHovered = {
        view: name,
        when: Date.now()
      };
    }

    const fetchAfterTimeout = () => {
      const startTime = Date.now();
      window.setTimeout(() => {
        if (
          this.lastHovered.view !== name ||
          startTime < this.lastHovered.when
        ) {
          console.info(
            "We are not hovering over the same view anymore so we are not going to fetch high resolution data."
          );
          return;
        }
        this.prefetchedData.get(name)!.fetchHighRes();
      }, this.config.progressiveTimeout);
    };

    if (this.activeView === name) return;

    if (this.prefetchedData.has(name)) {
      // we might have already prefetched but aborted a previous hover with wait
      if (this.config.progressiveInteractions) {
        fetchAfterTimeout();
      }
      return;
    }

    const view = this.views.get(name)!;

    let cubes: Promise<Cubes<V>> | Cubes<V>;
    let pixels: number | Interval<number>;

    if (view.type === "1D") {
      pixels = this.config.progressiveInteractions
        ? numBins(view.dimension.binConfig!)
        : this.highRes1D;
      cubes = this.load1DData(name, view, pixels);
    } else if (view.type === "2D") {
      pixels = this.config.progressiveInteractions
        ? [
            numBins(view.dimensions[0].binConfig!),
            numBins(view.dimensions[1].binConfig!)
          ]
        : [this.highRes2D, this.highRes2D];
      cubes = this.load2DData(name, view, pixels);
    } else {
      throw new Error("0D cannot be an active view.");
    }

    const vgView = this.vegaViews.get(name)!;
    vgView.container()!.style.cursor = "wait";
    (vgView.container()!.children.item(0) as HTMLElement).style.pointerEvents =
      "none";

    const pendingData = new PendingData(
      cubes,
      () => {
        // get high res data

        if (view.type === "1D") {
          return this.load1DData(name, view, this.highRes1D);
        } else {
          return this.load2DData(name, view, [this.highRes2D, this.highRes2D]);
        }
      },
      cubes => {
        if (this.prefetchedData.get(name) !== pendingData) {
          console.warn("Received outdated high res result that was ignored.");
          return;
        }

        console.info(`High res data available.`);

        this.vegaViews
          .get(name)!
          .signal(
            "pixels",
            this.views.get(name)!.type === "1D"
              ? this.highRes1D
              : [this.highRes2D, this.highRes2D]
          )
          .run();

        if (name === this.activeView) {
          this.cubes = cubes;

          if (this.config.interpolate) {
            this.update();
          }
        }
      }
    );

    this.prefetchedData.set(name, pendingData);

    // mark view as pending as long as we don't have required data
    const done = () => {
      if (this.prefetchedData.get(name) !== pendingData) {
        console.warn("Received outdated prefetch result that was ignored.");
        return;
      }

      vgView.container()!.style.cursor = null;
      (vgView
        .container()!
        .children.item(0) as HTMLElement).style.pointerEvents =
        "all";

      vgView
        .signal("pixels", pixels)
        .signal("ready", true)
        .run();

      if (this.config.progressiveInteractions) {
        fetchAfterTimeout();
      }
    };

    if (cubes instanceof Promise) {
      this.pendingRequests.set(name, this.pendingRequests.get(name) || 0 + 1);
      cubes.then(() => {
        const count = this.pendingRequests.get(name)! - 1;
        this.pendingRequests.set(name, count);
        if (count === 0) {
          done();
        }
      });
    } else {
      done();
    }
  }

  private load1DData(name: V, view: View1D<D>, pixels: number) {
    return this.db.loadData1D(
      view,
      pixels,
      omit(this.views, name),
      omit(this.brushes, view.dimension.name)
    );
  }

  private load2DData(name: V, view: View2D<D>, pixels: Interval<number>) {
    return this.db.loadData2D(
      view,
      pixels,
      omit(this.views, name),
      omit(this.brushes, ...view.dimensions.map(d => d.name))
    );
  }

  /**
   * Switch which view is active.
   */
  private async switchActiveView(name: V) {
    console.info(`Active view ${this.activeView} => ${name}`);

    for (const [n, v] of this.vegaViews) {
      if (n !== name) {
        v.runAfter(view => {
          if (this.views.get(name)!.type === "2D") {
            view.remove("interesting", truthy).resize();
          }
          view.signal("ready", false).run();
        });
      }
    }

    this.activeView = name;

    const activeView = this.getActiveView();
    const activeVgView = this.vegaViews.get(name)!;

    const data = this.prefetchedData.get(name)!;
    // data cubes should be ready since we only allow interactions with views that are ready
    this.cubes = await data.cubes();

    // need to clear because the brushes are changing now
    this.prefetchedData.clear();
    // add back data for this view so that we are not discarding requests
    this.prefetchedData.set(name, data);

    if (this.config.progressiveInteractions && !this.db.blocking) {
      // we are not using a blocking db and now this dimension is active so let's get high resolution data
      this.prefetchedData.get(name)!.fetchHighRes();
    }

    if (activeView.type === "1D" && this.config.showInterestingness) {
      // show basic interestingness
      activeVgView
        .change(
          "interesting",
          changeset()
            .remove(truthy)
            .insert(this.calculateInterestingness())
        )
        .resize()
        .run();
    }
  }

  /**
   * Compute an interestingness metric.
   */
  private calculateInterestingness(
    opt: { start?: number; window?: number } = {}
  ) {
    let out: {
      view: V;
      x: number;
      value: any;
    }[] = [];

    console.time("Compute interestingness");

    const pixels = this.getActiveVegaView().signal("pixels");

    for (const [name, view] of omit(this.views, this.activeView)) {
      if (view.type !== "0D") {
        let data: Array<any>;

        const { hists } = this.cubes.get(name)!;

        if (opt.window !== undefined) {
          const w = Math.floor(opt.window / 2);

          data = new Array(pixels - opt.window);

          for (let pixel = w; pixel < pixels - w; pixel++) {
            const distance = chEmd(
              hists.pick(pixel - w, null, null),
              hists.pick(pixel + w, null, null)
            );

            data[pixel - w] = {
              view: name,
              x: pixel,
              value: Math.log(distance + 1e-6)
            };
          }
        } else {
          data = new Array(pixels);

          // cache the start cumulative histogram
          let startChf: ndarray = ndarray([]);
          if (opt.start !== undefined) {
            startChf = hists.pick(opt.start, null, null);
          }

          for (let pixel = 0; pixel < pixels; pixel++) {
            let distance: number;

            if (opt.start !== undefined) {
              distance = chEmd(startChf, hists.pick(pixel, null, null));
            } else {
              distance = chEmd(
                hists.pick(pixel, null, null),
                hists.pick(pixel + 1, null, null)
              );
            }

            data[pixel] = {
              view: name,
              x: pixel,
              value: Math.log(distance + 1e-6)
            };
          }
        }

        out = out.concat(data);
      }
    }
    console.timeEnd("Compute interestingness");

    return out;
  }

  private async brushMove1D(name: V, dimension: D, value: [number, number]) {
    if (this.activeView !== name) {
      await this.switchActiveView(name);
    }

    // delete or set brush
    if (!value) {
      this.brushes.delete(dimension);
    } else {
      this.brushes.set(dimension, extent(value));
    }

    this.throttledUpdate();
  }

  private async brushMove2D(
    name: V,
    dim1: D,
    dim2: D,
    value: Interval<[number, number]>
  ) {
    if (this.activeView !== name) {
      await this.switchActiveView(name);
    }

    // delete or set brush
    if (!value) {
      this.brushes.delete(dim1);
      this.brushes.delete(dim2);
    } else {
      this.brushes.set(dim1, extent(value[0]));
      this.brushes.set(dim2, extent(value[1]));
    }

    this.throttledUpdate();
  }

  private getActiveView() {
    return this.views.get(this.activeView)! as View1D<D> | View2D<D>;
  }

  private getActiveVegaView() {
    return this.vegaViews.get(this.activeView)!;
  }

  private update0DView(name: V, value: number, base: boolean) {
    this.updateView(
      name,
      [
        {
          value: value
        }
      ],
      base
    );
  }

  private update1DView(name: V, view: View1D<D>, hist: ndarray, base: boolean) {
    const unbin = binToData(view.dimension.binConfig!);

    const data = new Array(hist.size);

    for (let x = 0; x < hist.shape[0]; x++) {
      data[x] = {
        key: unbin(x),
        value: hist.get(x)
      };
    }

    this.updateView(name, data, base);
  }

  private update2DView(name: V, view: View2D<D>, heat: ndarray, base: boolean) {
    const binConfigs = view.dimensions.map(d => d.binConfig!);
    const [binToDataX, binToDataY] = binConfigs.map(binToData);

    const data = new Array(heat.size);

    let i = 0;
    for (let x = 0; x < heat.shape[0]; x++) {
      for (let y = 0; y < heat.shape[1]; y++) {
        data[i++] = {
          keyX: binToDataX(x),
          keyY: binToDataY(y),
          value: heat.get(x, y)
        };
      }
    }

    this.updateView(name, data, base);
  }

  private updateView<T>(name: V, data: T[], base: boolean = false) {
    const changeSet = changeset()
      .remove(truthy)
      .insert(data);

    const vgView = this.vegaViews.get(name)!;
    vgView.runAfter(() => {
      vgView.change("table", changeSet);
      if (base) {
        vgView.change("base", changeSet);
      }
      vgView.run();
    });
  }

  private update() {
    const activeView = this.getActiveView();
    const activeVgView = this.getActiveVegaView();

    if (activeView.type === "1D") {
      const activeBrushFloat = extent(activeVgView.signal("binBrush"));

      let activeBrushFloor: number[] = [-1];
      let activeBrushCeil: number[] = [-1];
      let fraction: number[] = [-1];

      if (activeBrushFloat) {
        activeBrushFloor = activeBrushFloat.map(Math.floor);
        activeBrushCeil = activeBrushFloat.map(Math.ceil);
        fraction = [0, 1].map(i => activeBrushFloat![i] - activeBrushFloor![i]);
      }

      for (const [name, view] of this.views) {
        if (name === this.activeView) {
          continue;
        }

        const data = this.cubes.get(name)!;
        const hists = data.hists;

        if (view.type === "0D") {
          const value = activeBrushFloat
            ? this.config.interpolate
              ? (1 - fraction[1]) * hists.get(activeBrushFloor[1]) +
                fraction[1] * hists.get(activeBrushCeil[1]) -
                ((1 - fraction[0]) * hists.get(activeBrushFloor[0]) +
                  fraction[0] * hists.get(activeBrushCeil[0]))
              : hists.get(activeBrushFloor[1]) - hists.get(activeBrushFloor[0])
            : data.noBrush.data[0];

          this.update0DView(name, value, false);
        } else if (view.type === "1D") {
          const hist = activeBrushFloat
            ? this.config.interpolate
              ? subInterpolated(
                  hists.pick(activeBrushFloor[0], null),
                  hists.pick(activeBrushCeil[0], null),
                  hists.pick(activeBrushFloor[1], null),
                  hists.pick(activeBrushCeil[1], null),
                  fraction[0],
                  fraction[1]
                )
              : sub(
                  hists.pick(activeBrushFloor[0], null),
                  hists.pick(activeBrushFloor[1], null)
                )
            : data.noBrush;

          this.update1DView(name, view, hist, false);
        } else {
          const heat = activeBrushFloat
            ? this.config.interpolate
              ? subInterpolated(
                  hists.pick(activeBrushFloor[0], null, null),
                  hists.pick(activeBrushCeil[0], null, null),
                  hists.pick(activeBrushFloor[1], null, null),
                  hists.pick(activeBrushCeil[1], null, null),
                  fraction[0],
                  fraction[1]
                )
              : sub(
                  hists.pick(activeBrushFloor[0], null, null),
                  hists.pick(activeBrushFloor[1], null, null)
                )
            : data.noBrush;

          this.update2DView(name, view, heat, false);
        }
      }
    } else {
      let activeBrushFloat: Interval<Interval<number>> = activeVgView.signal(
        "binBrush"
      );

      let activeBrushFloorX: number[] = [-1];
      let activeBrushFloorY: number[] = [-1];

      if (activeBrushFloat) {
        activeBrushFloat = [
          extent(activeBrushFloat[0]),
          extent(activeBrushFloat[1])
        ];
        [activeBrushFloorX, activeBrushFloorY] = [
          activeBrushFloat[0].map(Math.floor),
          activeBrushFloat[1].map(Math.floor)
        ];
      }

      for (const [name, view] of this.views) {
        if (name === this.activeView) {
          continue;
        }
        const data = this.cubes.get(name)!;
        const hists = data.hists;

        if (view.type === "0D") {
          const value = activeBrushFloat
            ? hists.get(activeBrushFloorX[1], activeBrushFloorY[1]) -
              hists.get(activeBrushFloorX[1], activeBrushFloorY[0]) -
              hists.get(activeBrushFloorX[0], activeBrushFloorY[1]) +
              hists.get(activeBrushFloorX[0], activeBrushFloorY[0])
            : data.noBrush[0];

          this.update0DView(name, value, false);
        } else if (view.type === "1D") {
          const hist = activeBrushFloat
            ? summedAreaTableLookup(
                hists.pick(activeBrushFloorX[1], activeBrushFloorY[1], null),
                hists.pick(activeBrushFloorX[1], activeBrushFloorY[0], null),
                hists.pick(activeBrushFloorX[0], activeBrushFloorY[1], null),
                hists.pick(activeBrushFloorX[0], activeBrushFloorY[0], null)
              )
            : data.noBrush;

          this.update1DView(name, view, hist, false);
        } else {
          // not yet implemented
          console.warn("not yet implemented");
        }
      }
    }
  }
}
