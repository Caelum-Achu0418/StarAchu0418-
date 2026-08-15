import { useRef, useCallback, useEffect } from "react";

/**
 * Touch-based long-press drag-to-reorder hook.
 * Uses direct DOM manipulation during drag for 60fps smoothness,
 * only calls onReorder on touchend to trigger React state update.
 */

interface DragState {
    active: boolean;
    index: number;
    currentIndex: number;
    startY: number;
    startX: number;
    latestY: number;
    items: { top: number; height: number; el: HTMLElement }[];
    gap: number;
    timer: ReturnType<typeof setTimeout> | null;
    autoScrollFrame: number | null;
    scrollLock: {
        el: HTMLElement;
        overflowY: string;
        touchAction: string;
        scrollTop: number;
    } | null;
    bodyOverflow: string;
    bodyTouchAction: string;
}

const INITIAL: DragState = {
    active: false, index: -1, currentIndex: -1,
    startY: 0, startX: 0, latestY: 0, items: [], gap: 0, timer: null,
    autoScrollFrame: null,
    scrollLock: null, bodyOverflow: "", bodyTouchAction: "",
};

const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_MAX_STEP = 14;

export function useTouchSort(
    onReorder: (from: number, to: number) => void,
    longPressMs = 400,
) {
    const dragRef = useRef<DragState>({ ...INITIAL });
    const containerRef = useRef<HTMLDivElement>(null);
    const documentTouchMoveCleanupRef = useRef<(() => void) | null>(null);

    const stopPreventingDocumentScroll = useCallback(() => {
        documentTouchMoveCleanupRef.current?.();
        documentTouchMoveCleanupRef.current = null;
    }, []);

    const startPreventingDocumentScroll = useCallback(() => {
        if (documentTouchMoveCleanupRef.current) return;

        const preventScrollDuringDrag = (event: TouchEvent) => {
            const d = dragRef.current;
            if (!d.active) return;
            if (event.cancelable) event.preventDefault();
        };

        document.addEventListener("touchmove", preventScrollDuringDrag, { passive: false });
        documentTouchMoveCleanupRef.current = () => {
            document.removeEventListener("touchmove", preventScrollDuringDrag);
        };
    }, []);

    const cleanup = useCallback(() => {
        const d = dragRef.current;
        if (d.timer) { clearTimeout(d.timer); d.timer = null; }
        if (d.autoScrollFrame !== null) {
            cancelAnimationFrame(d.autoScrollFrame);
            d.autoScrollFrame = null;
        }
        d.items.forEach(({ el }) => {
            el.style.transition = "";
            el.style.transform = "";
            el.style.zIndex = "";
            el.style.boxShadow = "";
            el.style.position = "";
            el.style.pointerEvents = "";
        });
        if (d.scrollLock) {
            d.scrollLock.el.style.overflowY = d.scrollLock.overflowY;
            d.scrollLock.el.style.touchAction = d.scrollLock.touchAction;
            d.scrollLock = null;
        }
        document.body.style.overflow = d.bodyOverflow;
        document.body.style.touchAction = d.bodyTouchAction;
        stopPreventingDocumentScroll();
        d.active = false;
    }, [stopPreventingDocumentScroll]);

    const lockScroll = useCallback((container: HTMLElement) => {
        const d = dragRef.current;
        const scrollEl = (
            container.closest(".page-body") ||
            document.scrollingElement ||
            document.documentElement
        ) as HTMLElement;

        d.scrollLock = {
            el: scrollEl,
            overflowY: scrollEl.style.overflowY,
            touchAction: scrollEl.style.touchAction,
            scrollTop: scrollEl.scrollTop,
        };
        d.bodyOverflow = document.body.style.overflow;
        d.bodyTouchAction = document.body.style.touchAction;

        scrollEl.style.touchAction = "none";
        document.body.style.touchAction = "none";
    }, []);

    const getScrollDelta = useCallback((d: DragState) => (
        d.scrollLock ? d.scrollLock.el.scrollTop - d.scrollLock.scrollTop : 0
    ), []);

    const applyDragPosition = useCallback((clientY: number) => {
        const d = dragRef.current;
        const dragged = d.items[d.index];
        if (!d.active || !dragged) return;

        const deltaY = clientY - d.startY;
        const scrollDelta = getScrollDelta(d);

        // move dragged item with finger
        dragged.el.style.transition = "box-shadow 200ms";
        dragged.el.style.transform = `translateY(${deltaY + scrollDelta}px) scale(1.02)`;

        // find target position based on dragged item's center in scroll content coordinates
        const draggedCenter = dragged.top + dragged.height / 2 + deltaY + scrollDelta;
        let newIndex = d.index;
        for (let i = 0; i < d.items.length; i++) {
            if (i === d.index) continue;
            const mid = d.items[i].top + d.items[i].height / 2;
            if (d.index < i && draggedCenter > mid) newIndex = Math.max(newIndex, i);
            else if (d.index > i && draggedCenter < mid) newIndex = Math.min(newIndex, i);
        }

        // shift other items to make room
        const shift = dragged.height + d.gap;
        for (let i = 0; i < d.items.length; i++) {
            if (i === d.index) continue;
            const el = d.items[i].el;
            el.style.transition = "transform 200ms ease";
            if (i > d.index && i <= newIndex) {
                el.style.transform = `translateY(-${shift}px)`;
            } else if (i < d.index && i >= newIndex) {
                el.style.transform = `translateY(${shift}px)`;
            } else {
                el.style.transform = "";
            }
        }

        d.currentIndex = newIndex;
    }, [getScrollDelta]);

    const getScrollViewport = useCallback((el: HTMLElement) => {
        if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
            return { top: 0, bottom: window.innerHeight };
        }
        const rect = el.getBoundingClientRect();
        const header = el.closest(".page-shell")?.querySelector(".page-header");
        const headerBottom = header instanceof HTMLElement ? header.getBoundingClientRect().bottom : rect.top;
        return { top: Math.max(rect.top, headerBottom - AUTO_SCROLL_EDGE), bottom: rect.bottom };
    }, []);

    const startAutoScroll = useCallback(() => {
        const step = () => {
            const d = dragRef.current;
            const lock = d.scrollLock;
            if (!d.active || !lock) {
                d.autoScrollFrame = null;
                return;
            }

            const { top, bottom } = getScrollViewport(lock.el);
            const distanceToTop = d.latestY - top;
            const distanceToBottom = bottom - d.latestY;
            let scrollStep = 0;

            if (distanceToTop < AUTO_SCROLL_EDGE) {
                const ratio = Math.max(0, Math.min(1, 1 - distanceToTop / AUTO_SCROLL_EDGE));
                scrollStep = -Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
            } else if (distanceToBottom < AUTO_SCROLL_EDGE) {
                const ratio = Math.max(0, Math.min(1, 1 - distanceToBottom / AUTO_SCROLL_EDGE));
                scrollStep = Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
            }

            if (scrollStep !== 0) {
                const maxScroll = lock.el.scrollHeight - lock.el.clientHeight;
                const nextScrollTop = Math.max(0, Math.min(maxScroll, lock.el.scrollTop + scrollStep));
                if (nextScrollTop !== lock.el.scrollTop) {
                    lock.el.scrollTop = nextScrollTop;
                    applyDragPosition(d.latestY);
                }
            }

            d.autoScrollFrame = requestAnimationFrame(step);
        };

        const d = dragRef.current;
        if (d.autoScrollFrame === null) d.autoScrollFrame = requestAnimationFrame(step);
    }, [applyDragPosition, getScrollViewport]);

    const finishDrag = useCallback(() => {
        const d = dragRef.current;
        if (d.timer) { clearTimeout(d.timer); d.timer = null; }
        if (!d.active) return;

        const from = d.index;
        const to = d.currentIndex;
        cleanup();

        if (from !== to) onReorder(from, to);
    }, [onReorder, cleanup]);

    useEffect(() => {
        const handleTouchEnd = () => finishDrag();

        window.addEventListener("touchend", handleTouchEnd);
        window.addEventListener("touchcancel", handleTouchEnd);
        return () => {
            window.removeEventListener("touchend", handleTouchEnd);
            window.removeEventListener("touchcancel", handleTouchEnd);
            stopPreventingDocumentScroll();
        };
    }, [finishDrag, stopPreventingDocumentScroll]);

    const beginDrag = useCallback((index: number) => {
        const d = dragRef.current;
        const container = containerRef.current;
        if (!container) return;

        d.active = true;
        const children = Array.from(container.children) as HTMLElement[];
        d.items = children.map(el => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, height: rect.height, el };
        });

        // compute gap from adjacent items
        d.gap = children.length > 1
            ? d.items[1].top - (d.items[0].top + d.items[0].height)
            : 0;

        // visual feedback on dragged item
        const el = children[index];
        el.style.zIndex = "100";
        el.style.transition = "box-shadow 200ms, transform 150ms";
        el.style.transform = "scale(1.02)";
        el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
        el.style.position = "relative";

        // prevent the scrollable page body from competing with the sort gesture
        lockScroll(container);
        startPreventingDocumentScroll();
        startAutoScroll();

        if (navigator.vibrate) navigator.vibrate(25);
    }, [lockScroll, startAutoScroll, startPreventingDocumentScroll]);

    const onTouchStart = useCallback((index: number, e: React.TouchEvent) => {
        const d = dragRef.current;
        if (d.timer) clearTimeout(d.timer);

        const touch = e.touches[0];
        d.startY = touch.clientY;
        d.startX = touch.clientX;
        d.latestY = touch.clientY;
        d.index = index;
        d.currentIndex = index;

        if (longPressMs <= 0) {
            if (e.cancelable) e.preventDefault();
            beginDrag(index);
            return;
        }

        d.timer = setTimeout(() => beginDrag(index), longPressMs);
    }, [longPressMs, beginDrag]);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        const d = dragRef.current;
        const touch = e.touches[0];

        if (!d.active) {
            // cancel long-press if finger moved too far
            const dx = Math.abs(touch.clientX - d.startX);
            const dy = Math.abs(touch.clientY - d.startY);
            if ((dx > 8 || dy > 8) && d.timer) {
                clearTimeout(d.timer);
                d.timer = null;
            }
            return;
        }

        if (e.cancelable) e.preventDefault();
        d.latestY = touch.clientY;
        applyDragPosition(touch.clientY);
    }, [applyDragPosition]);

    const onTouchEnd = useCallback(() => finishDrag(), [finishDrag]);

    return { containerRef, onTouchStart, onTouchMove, onTouchEnd };
}
