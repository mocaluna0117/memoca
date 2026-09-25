import { afterEach, describe, expect, test } from "vitest";
import {
  AXIS_RATIO,
  FLICK_PX_PER_MS,
  HOLD_MS,
  SLOP_PX,
  VELOCITY_WINDOW_MS,
  type Sample,
  addSample,
  dragOffset,
  lockAxis,
  nearestPlace,
  openness,
  releaseVelocity,
  restingPlace,
  swipeAllowed,
  touchBelongsElsewhere,
} from "@/lib/gesture/drawer-swipe";

const WIDTH = 320;

describe("deciding what a touch is", () => {
  test("waits until the finger has moved past the slop", () => {
    expect(lockAxis(0, 0, 0, 1)).toBe("pending");
    expect(lockAxis(6, 6, 50, 1)).toBe("pending"); // about 8.5px
    expect(lockAxis(SLOP_PX - 0.5, 0, 50, 1)).toBe("pending");
    expect(lockAxis(SLOP_PX, 0, 50, 1)).toBe("drag");
  });

  test("a sideways move in the drawer's direction is a swipe", () => {
    expect(lockAxis(12, 0, 80, 1)).toBe("drag");
    expect(lockAxis(-12, 0, 80, -1)).toBe("drag");
    expect(lockAxis(12, -4, 80, 1)).toBe("drag");
  });

  test("the other way is not", () => {
    expect(lockAxis(-12, 0, 80, 1)).toBe("ignore");
    expect(lockAxis(12, 0, 80, -1)).toBe("ignore");
  });

  test("sideways means at least 1.2 times as far across as up or down", () => {
    expect(lockAxis(12, 10, 80, 1)).toBe("drag");
    expect(lockAxis(AXIS_RATIO * 10, 10, 80, 1)).toBe("drag");
    expect(lockAxis(11.9, 10, 80, 1)).toBe("ignore");
    expect(lockAxis(12, -10.1, 80, 1)).toBe("ignore");
  });

  test("a vertical move is the page's scroll", () => {
    expect(lockAxis(0, 12, 80, 1)).toBe("ignore");
    expect(lockAxis(3, -40, 80, -1)).toBe("ignore");
  });

  test("a finger that rested before moving is selecting text, not swiping", () => {
    expect(lockAxis(2, 0, HOLD_MS - 1, 1)).toBe("pending");
    expect(lockAxis(40, 0, HOLD_MS - 1, 1)).toBe("drag");
    expect(lockAxis(2, 0, HOLD_MS, 1)).toBe("ignore");
    expect(lockAxis(40, 0, HOLD_MS, 1)).toBe("ignore");
    expect(lockAxis(40, 0, 2_000, -1)).toBe("ignore");
  });
});

describe("where the drawer is under the finger", () => {
  test("opening starts from shut, without a jump by the slop", () => {
    expect(dragOffset(SLOP_PX, WIDTH, 1, -WIDTH)).toBe(-WIDTH);
    expect(dragOffset(SLOP_PX + 100, WIDTH, 1, -WIDTH)).toBe(-WIDTH + 100);
    expect(dragOffset(SLOP_PX + WIDTH, WIDTH, 1, -WIDTH)).toBe(0);
  });

  test("closing starts from wherever the drawer was", () => {
    expect(dragOffset(-SLOP_PX, WIDTH, -1, 0)).toBe(0);
    expect(dragOffset(-SLOP_PX - 100, WIDTH, -1, 0)).toBe(-100);
    expect(dragOffset(-SLOP_PX - 100, WIDTH, -1, -40)).toBe(-140);
  });

  test("never past fully open or past shut", () => {
    expect(dragOffset(1_000, WIDTH, 1, -WIDTH)).toBe(0);
    expect(dragOffset(-300, WIDTH, 1, -WIDTH)).toBe(-WIDTH);
    expect(dragOffset(200, WIDTH, -1, 0)).toBe(0);
    expect(dragOffset(-1_000, WIDTH, -1, 0)).toBe(-WIDTH);
  });

  test("openness runs from 0 shut to 1 open", () => {
    expect(openness(-WIDTH, WIDTH)).toBe(0);
    expect(openness(-WIDTH / 2, WIDTH)).toBe(0.5);
    expect(openness(0, WIDTH)).toBe(1);
    expect(openness(-2 * WIDTH, WIDTH)).toBe(0);
    expect(openness(0, 0)).toBe(0);
  });
});

describe("how fast the finger let go", () => {
  const moving = (from: number, speed: number, until: number, every = 16) => {
    let samples: Sample[] = [];
    for (let t = 0; t <= until; t += every)
      samples = addSample(samples, { t, x: from + speed * t });
    return samples;
  };

  test("is the speed over the last stretch, in px/ms", () => {
    expect(releaseVelocity(moving(0, 1, 320), 320)).toBeCloseTo(1);
    expect(releaseVelocity(moving(300, -0.5, 320), 320)).toBeCloseTo(-0.5);
  });

  test("forgets how it started", () => {
    // Slow for a long while, then quick at the end.
    let samples = moving(0, 0.05, 480);
    const last = samples[samples.length - 1];
    for (let t = last.t + 16; t <= last.t + 96; t += 16) {
      samples = addSample(samples, { t, x: last.x + 1.5 * (t - last.t) });
    }
    const end = samples[samples.length - 1].t;
    expect(releaseVelocity(samples, end)).toBeGreaterThan(1);
  });

  test("keeps only what the measurement needs", () => {
    const samples = moving(0, 1, 2_000);
    expect(samples.length).toBeLessThanOrEqual(VELOCITY_WINDOW_MS / 16 + 1);
    expect(samples[0].t).toBeGreaterThanOrEqual(2_000 - VELOCITY_WINDOW_MS - 16);
  });

  test("is zero for a finger that stopped before letting go", () => {
    const samples = moving(0, 1, 200);
    expect(releaseVelocity(samples, 200 + VELOCITY_WINDOW_MS + 1)).toBe(0);
    // Held still for a moment: the release point repeats the last position.
    const held = addSample(samples, { t: 400, x: samples[samples.length - 1].x });
    expect(releaseVelocity(held, 400)).toBe(0);
  });

  test("needs two samples at different times", () => {
    expect(releaseVelocity([], 0)).toBe(0);
    expect(releaseVelocity([{ t: 10, x: 50 }], 10)).toBe(0);
    expect(
      releaseVelocity(
        [
          { t: 10, x: 50 },
          { t: 10, x: 90 },
        ],
        10,
      ),
    ).toBe(0);
  });

  test("a flick with a single move counts from where the finger came down", () => {
    // The touch starts the samples, as useDrawerSwipe does: otherwise the one
    // move and the release at the same place would read as standing still.
    let samples = addSample([], { t: 0, x: 40 });
    samples = addSample(samples, { t: 16, x: 100 });
    samples = addSample(samples, { t: 20, x: 100 });
    const velocity = releaseVelocity(samples, 20);
    expect(velocity).toBeCloseTo(3);
    // Barely past the slop, and still it opens.
    const offset = dragOffset(60, WIDTH, 1, -WIDTH);
    expect(restingPlace({ offset, width: WIDTH, velocity })).toBe("open");
  });

  test("a rest before the move is forgotten with the touch that started it", () => {
    let samples = addSample([], { t: 0, x: 40 });
    samples = addSample(samples, { t: 300, x: 44 });
    samples = addSample(samples, { t: 316, x: 60 });
    expect(releaseVelocity(samples, 316)).toBeCloseTo(1);
  });

  test("sparse moves still count", () => {
    const samples = [
      { t: 0, x: 0 },
      { t: 50, x: 40 },
      { t: 100, x: 80 },
    ];
    expect(releaseVelocity(samples, 100)).toBeCloseTo(0.8);
  });
});

describe("where the drawer comes to rest", () => {
  test("a flick decides by its direction, wherever the drawer is", () => {
    expect(restingPlace({ offset: -300, width: WIDTH, velocity: FLICK_PX_PER_MS })).toBe("open");
    expect(restingPlace({ offset: -300, width: WIDTH, velocity: 2 })).toBe("open");
    expect(restingPlace({ offset: -10, width: WIDTH, velocity: -FLICK_PX_PER_MS })).toBe("closed");
    expect(restingPlace({ offset: 0, width: WIDTH, velocity: -2 })).toBe("closed");
  });

  test("slower than a flick, more than half open stays open", () => {
    expect(restingPlace({ offset: -100, width: WIDTH, velocity: 0.39 })).toBe("open");
    expect(restingPlace({ offset: -100, width: WIDTH, velocity: -0.39 })).toBe("open");
    expect(restingPlace({ offset: -200, width: WIDTH, velocity: 0.39 })).toBe("closed");
    expect(restingPlace({ offset: -200, width: WIDTH, velocity: 0 })).toBe("closed");
  });

  test("exactly half open is not past half", () => {
    expect(restingPlace({ offset: -WIDTH / 2, width: WIDTH, velocity: 0 })).toBe("closed");
    expect(restingPlace({ offset: -WIDTH / 2 + 1, width: WIDTH, velocity: 0 })).toBe("open");
  });

  test("a short, slow drag goes back", () => {
    const offset = dragOffset(SLOP_PX + 90, WIDTH, 1, -WIDTH);
    expect(restingPlace({ offset, width: WIDTH, velocity: 0.15 })).toBe("closed");
  });

  test("a gesture cut short goes to the nearer place", () => {
    expect(nearestPlace(-40, WIDTH)).toBe("open");
    expect(nearestPlace(-280, WIDTH)).toBe("closed");
  });
});

describe("when a swipe may start", () => {
  const phone = { phone: true, touches: 1, scale: 1, modalOpen: false };

  test("on a phone, with one finger", () => {
    expect(swipeAllowed(phone)).toBe(true);
    expect(swipeAllowed({ ...phone, phone: false })).toBe(false);
    expect(swipeAllowed({ ...phone, touches: 2 })).toBe(false);
    expect(swipeAllowed({ ...phone, touches: 0 })).toBe(false);
  });

  test("not while the page is pinch-zoomed", () => {
    expect(swipeAllowed({ ...phone, scale: 1.01 })).toBe(true);
    expect(swipeAllowed({ ...phone, scale: 1.2 })).toBe(false);
  });

  test("not while something else is modal, such as the vault prompt", () => {
    expect(swipeAllowed({ ...phone, modalOpen: true })).toBe(false);
  });
});

describe("touches that belong to something else", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.getSelection()?.removeAllRanges();
  });

  /** Builds a tree under body and returns the element with data-root. */
  const mount = (html: string) => {
    document.body.innerHTML = html;
    return document.querySelector("[data-root]")!;
  };
  const $ = (selector: string) => document.querySelector(selector)!;

  /** jsdom has no layout, so an overflowing box is given its sizes by hand. */
  const overflowing = (element: Element, scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(element, "scrollWidth", { value: scrollWidth, configurable: true });
    Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
  };

  test("plain content is the drawer's", () => {
    const root = mount(
      '<main data-root><section><p id="t">メモ</p><button id="b">行</button></section></main>',
    );
    expect(touchBelongsElsewhere($("#t"), root, "page")).toBe(false);
    expect(touchBelongsElsewhere($("#b"), root, "page")).toBe(false);
    expect(touchBelongsElsewhere(root, root, "page")).toBe(false);
  });

  test("a text node counts as the element around it", () => {
    const root = mount(
      '<main data-root><p id="t">メモ</p><div role="toolbar"><span id="tool">太字</span></div></main>',
    );
    expect(touchBelongsElsewhere($("#t").firstChild, root, "page")).toBe(false);
    expect(touchBelongsElsewhere($("#tool").firstChild, root, "page")).toBe(true);
  });

  test("fields, sliders and the block toolbar keep the finger", () => {
    const root = mount(`
      <main data-root>
        <input id="input">
        <textarea id="textarea"></textarea>
        <select id="select"><option>a</option></select>
        <div role="slider" id="slider"><span id="thumb"></span></div>
        <div role="toolbar"><div><button id="tool">見出し</button></div></div>
      </main>`);
    for (const id of ["input", "textarea", "select", "slider", "thumb", "tool"]) {
      expect(touchBelongsElsewhere($(`#${id}`), root, "page"), id).toBe(true);
    }
  });

  test("a video or audio player keeps it, for its timeline", () => {
    // The browser draws the controls out of the page's reach, so the touch is
    // reported on the player itself.
    const root = mount(`
      <main data-root>
        <div class="bn-file-block-content-wrapper"><video id="video" controls></video></div>
        <audio id="audio" controls></audio>
        <video id="silent"></video>
      </main>`);
    expect(touchBelongsElsewhere($("#video"), root, "page")).toBe(true);
    expect(touchBelongsElsewhere($("#audio"), root, "page")).toBe(true);
    // Without controls there is nothing to scrub.
    expect(touchBelongsElsewhere($("#silent"), root, "page")).toBe(false);
  });

  test("the editor's own handles and menus keep it", () => {
    const root = mount(`
      <main data-root>
        <div class="bn-resize-handle" id="resize"></div>
        <div class="bn-toolbar"><button id="format">B</button></div>
        <div class="bn-suggestion-menu"><div id="suggestion">見出し</div></div>
        <div class="bn-side-menu"><div id="side"></div></div>
        <div class="bn-drag-handle" id="drag"></div>
        <div draggable="true"><span id="draggable"></span></div>
        <div data-no-drawer-swipe><div id="crop"></div></div>
      </main>`);
    for (const id of ["resize", "format", "suggestion", "side", "drag", "draggable", "crop"]) {
      expect(touchBelongsElsewhere($(`#${id}`), root, "page"), id).toBe(true);
    }
  });

  test("draggable only when it says true", () => {
    const root = mount('<main data-root><div draggable="false"><span id="t"></span></div></main>');
    expect(touchBelongsElsewhere($("#t"), root, "page")).toBe(false);
  });

  test("inside something that scrolls sideways, such as a wide table or a code block", () => {
    const root = mount(`
      <main data-root>
        <div class="tableWrapper" id="table" style="overflow-x: auto">
          <table><tbody><tr><td><p id="cell">セル</p></td></tr></tbody></table>
        </div>
        <pre id="code" style="overflow-x: scroll"><code id="line">const long = 1;</code></pre>
      </main>`);
    overflowing($("#table"), 900, 380);
    overflowing($("#code"), 900, 380);
    expect(touchBelongsElsewhere($("#cell"), root, "page")).toBe(true);
    expect(touchBelongsElsewhere($("#line"), root, "page")).toBe(true);
  });

  test("not when there is nothing to scroll to, or it only clips", () => {
    const root = mount(`
      <main data-root>
        <pre id="short" style="overflow-x: auto"><code id="line">a</code></pre>
        <div id="hidden" style="overflow-x: hidden"><span id="clipped"></span></div>
        <div id="almost" style="overflow-x: auto"><span id="rounding"></span></div>
      </main>`);
    overflowing($("#short"), 380, 380);
    overflowing($("#hidden"), 900, 380);
    // A pixel of sub-pixel rounding is not overflow.
    overflowing($("#almost"), 381, 380);
    expect(touchBelongsElsewhere($("#line"), root, "page")).toBe(false);
    expect(touchBelongsElsewhere($("#clipped"), root, "page")).toBe(false);
    expect(touchBelongsElsewhere($("#rounding"), root, "page")).toBe(false);
  });

  test("only between the target and the root", () => {
    mount(`
      <div role="toolbar" style="overflow-x: auto" id="outer">
        <main data-root><p id="t">メモ</p></main>
      </div>`);
    overflowing($("#outer"), 900, 380);
    expect(touchBelongsElsewhere($("#t"), $("[data-root]"), "page")).toBe(false);
  });

  test("a touch outside the root, or without a target, is not the drawer's", () => {
    const root = mount('<main data-root></main><nav><a id="away">設定</a></nav>');
    expect(touchBelongsElsewhere($("#away"), root, "page")).toBe(true);
    expect(touchBelongsElsewhere(null, root, "page")).toBe(true);
    expect(touchBelongsElsewhere(window, root, "page")).toBe(true);
  });

  test("inside the editor, only while text is selected", () => {
    const root = mount(`
      <main data-root>
        <div contenteditable="true" id="editor"><p id="line">買い物リスト</p></div>
        <p id="outside">別の段落</p>
      </main>`);
    const text = $("#line").firstChild!;
    const selection = document.getSelection()!;
    expect(touchBelongsElsewhere($("#line"), root, "page")).toBe(false);

    const caret = document.createRange();
    caret.setStart(text, 2);
    caret.collapse(true);
    selection.addRange(caret);
    expect(touchBelongsElsewhere($("#line"), root, "page")).toBe(false);

    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    selection.addRange(range);
    expect(touchBelongsElsewhere($("#line"), root, "page")).toBe(true);
    // A selection elsewhere does not stop a swipe outside the editor.
    expect(touchBelongsElsewhere($("#outside"), root, "page")).toBe(false);
  });

  test("a non-editable island still belongs to the editor around it", () => {
    const root = mount(`
      <main data-root>
        <div contenteditable="true"><p id="line">本文</p><div contenteditable="false"><span id="island">画像</span></div></div>
      </main>`);
    const range = document.createRange();
    range.selectNodeContents($("#line"));
    document.getSelection()!.addRange(range);
    expect(touchBelongsElsewhere($("#island"), root, "page")).toBe(true);
  });

  test("in the open drawer, its menus, rename fields and scrollbar keep the finger", () => {
    const root = mount(`
      <div role="dialog" data-root>
        <div data-inline-rename><span id="rename"></span></div>
        <div role="menu"><div role="menuitem" id="item">名前を変更</div></div>
        <div data-slot="popover-content"><button id="close-vault">金庫を閉じる</button></div>
        <div data-slot="scroll-area-scrollbar"><div id="thumb"></div></div>
        <button id="folder">仕事</button>
      </div>`);
    for (const id of ["rename", "item", "close-vault", "thumb"]) {
      expect(touchBelongsElsewhere($(`#${id}`), root, "drawer"), id).toBe(true);
    }
    expect(touchBelongsElsewhere($("#folder"), root, "drawer")).toBe(false);
  });

  test("the drawer's own exclusions do not apply to the page", () => {
    const root = mount('<main data-root><div role="menu"><span id="t"></span></div></main>');
    expect(touchBelongsElsewhere($("#t"), root, "page")).toBe(false);
    expect(touchBelongsElsewhere($("#t"), root, "drawer")).toBe(true);
  });

  test("and the page's apply in the drawer too", () => {
    const root = mount(
      '<div data-root><input id="i"><div data-no-drawer-swipe><span id="t"></span></div></div>',
    );
    expect(touchBelongsElsewhere($("#i"), root, "drawer")).toBe(true);
    expect(touchBelongsElsewhere($("#t"), root, "drawer")).toBe(true);
  });
});
