"use client";

import { useState, useEffect, useRef } from "react";
import { loadRawFileBlob } from "@/lib/reading-storage";
import { splitBilingualText } from "@/lib/bilingual-text";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";

import type { ReadingAnnotation, BookChapter } from "@/lib/reading-types";

type Props = {
    bookId: string;
    chapter?: BookChapter;
    annotations?: ReadingAnnotation[];
    bilingualTranslationEnabled?: boolean;
    collapseBilingualTranslation?: boolean;
    onTotalPages?: (n: number) => void;
    onCurrentPage?: (page: number) => void;
    jumpToPage?: number;
    onCopyAnnotation?: (text: string) => void;
    onDeleteAnnotation?: (annotationId: string) => void;
};

const PDFJS_VERSION = "3.11.174";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
const PRELOAD_RADIUS = 3;
const PRELOAD_ROOT_MARGIN = "1800px 0px";
let _pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) { resolve((window as any).pdfjsLib); return; }
        const script = document.createElement("script");
        script.src = `${PDFJS_CDN}/pdf.min.js`;
        script.type = "text/javascript";
        script.onload = () => {
            const lib = (window as any).pdfjsLib;
            if (lib) {
                lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
                resolve(lib);
            } else reject(new Error("pdfjsLib not found"));
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js"));
        document.head.appendChild(script);
    });
    return _pdfjsPromise;
}

export function PdfPageRenderer({
    bookId,
    chapter,
    annotations,
    bilingualTranslationEnabled = false,
    collapseBilingualTranslation = true,
    onTotalPages,
    onCurrentPage,
    jumpToPage,
    onCopyAnnotation,
    onDeleteAnnotation,
}: Props) {
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<any | null>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const renderSeqRef = useRef(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [docVersion, setDocVersion] = useState(0);
    const scaleRef = useRef(1);
    const [scale, setScale] = useState(1);
    const renderedPagesRef = useRef(new Set<number>());
    const renderingPagesRef = useRef(new Map<number, Promise<void>>());
    const reportedPageRef = useRef(0);
    const cleanupRef = useRef<(() => void) | null>(null);

    const pinchRef = useRef({
        startDist: 0,
        startScale: 1,
        screenX: 0,
        screenY: 0,
        contentX: 0,
        contentY: 0,
    });

    const getRenderMetrics = () => {
        const scrollParent = canvasContainerRef.current?.closest("[data-ui='body']") as HTMLElement | null;
        const cssWidth = wrapperRef.current?.clientWidth || scrollParent?.clientWidth || 350;
        const renderDpr = Math.max(window.devicePixelRatio || 1, 2);
        return { cssWidth, scrollParent, renderDpr };
    };

    // Load PDF document once per book.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let objectUrl: string | null = null;
            try {
                setError(null);
                setLoading(true);
                pdfDocRef.current = null;
                observerRef.current?.disconnect();
                scaleRef.current = 1;
                setScale(1);

                const rawData = await loadRawFileBlob(bookId);
                if (cancelled) return;
                if (!rawData || rawData.size === 0) {
                    setError("PDF 文件未找到或为空");
                    setLoading(false);
                    return;
                }
                const pdfjsLib = await loadPdfjs();
                objectUrl = URL.createObjectURL(rawData);
                const pdf = await pdfjsLib.getDocument({ url: objectUrl }).promise;
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
                if (cancelled) return;
                pdfDocRef.current = pdf;
                onTotalPages?.(pdf.numPages);
                setDocVersion((v) => v + 1);
            } catch (err) {
                if (!cancelled) setError(`PDF 加载失败: ${err instanceof Error ? err.message : String(err)}`);
                if (!cancelled) setLoading(false);
            } finally {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            }
        })();
        return () => {
            cancelled = true;
            observerRef.current?.disconnect();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookId]);

    // Re-render every page at the committed zoom level after the gesture ends.
    useEffect(() => {
        const pdf = pdfDocRef.current;
        const container = canvasContainerRef.current;
        if (!pdf || !container) return;

        let cancelled = false;
        const renderSeq = ++renderSeqRef.current;

        (async () => {
            try {
                observerRef.current?.disconnect();
                renderedPagesRef.current.clear();
                renderingPagesRef.current.clear();
                reportedPageRef.current = 0;

                const { cssWidth, scrollParent, renderDpr } = getRenderMetrics();
                const pageRoot = scrollParent || wrapperRef.current;
                const firstPage = await pdf.getPage(1);
                const firstViewport = firstPage.getViewport({ scale: 1 });
                const defaultCssHeight = cssWidth * (firstViewport.height / firstViewport.width);
                firstPage.cleanup?.();

                const fragment = document.createDocumentFragment();
                const pageWrappers = new Map<number, HTMLDivElement>();

                const createAnnotationPin = (pageNum: number) => {
                    if (!chapter?.paragraphPages || !annotations?.length) return [] as HTMLDivElement[];
                    const elements: HTMLDivElement[] = [];
                    for (const ann of annotations) {
                        const pIdx = ann.paragraphIndex;
                        if (pIdx < 0 || pIdx >= (chapter.paragraphPages?.length || 0)) continue;
                        if (chapter.paragraphPages[pIdx] !== pageNum) continue;
                        const yRatio = chapter.paragraphYPositions?.[pIdx] ?? 0.5;

                        const annEl = document.createElement("div");
                        annEl.className = "reading-ann-pin";
                        annEl.style.top = `${yRatio * 100}%`;
                        annEl.dataset.expanded = "false";
                        annEl.dataset.noNav = "true";
                        const tagEl = document.createElement("span");
                        tagEl.className = "reading-ann-pin-tag";
                        tagEl.textContent = `💬 ${ann.characterName}`;

                        const bodyEl = document.createElement("div");
                        bodyEl.className = "reading-ann-pin-body";

                        const nameEl = document.createElement("span");
                        nameEl.className = "reading-annotation-name";
                        nameEl.textContent = ann.characterName;

                        const textEl = document.createElement("div");
                        textEl.className = "reading-annotation-text";

                        const bilingual = bilingualTranslationEnabled ? splitBilingualText(ann.content) : null;
                        if (!bilingual) {
                            textEl.textContent = ann.content;
                        } else {
                            const originalEl = document.createElement("div");
                            originalEl.textContent = bilingual.original;

                            const toggleBtn = document.createElement("button");
                            toggleBtn.type = "button";
                            toggleBtn.className = "chat-bilingual-toggle reading-annotation-bilingual-toggle";
                            toggleBtn.textContent = collapseBilingualTranslation ? "中文" : "收起中文";

                            const translationEl = document.createElement("div");
                            translationEl.className = "reading-annotation-translation";
                            translationEl.textContent = bilingual.translated;
                            translationEl.style.display = collapseBilingualTranslation ? "none" : "block";

                            toggleBtn.onclick = (e) => {
                                e.stopPropagation();
                                const expanded = translationEl.style.display !== "none";
                                translationEl.style.display = expanded ? "none" : "block";
                                toggleBtn.textContent = expanded ? "中文" : "收起中文";
                            };

                            textEl.append(originalEl, toggleBtn, translationEl);
                        }

                        const menuEl = document.createElement("div");
                        menuEl.className = "ctx-menu reading-annotation-menu";

                        const copyBtn = document.createElement("button");
                        copyBtn.className = "ctx-menu-btn";
                        copyBtn.textContent = "复制";
                        copyBtn.onclick = (e) => {
                            e.stopPropagation();
                            onCopyAnnotation?.(ann.content);
                            menuEl.dataset.open = "false";
                        };

                        const deleteBtn = document.createElement("button");
                        deleteBtn.className = "ctx-menu-btn ctx-menu-btn-danger";
                        deleteBtn.textContent = "删除";
                        deleteBtn.onclick = (e) => {
                            e.stopPropagation();
                            onDeleteAnnotation?.(ann.id);
                            menuEl.dataset.open = "false";
                        };

                        menuEl.dataset.open = "false";
                        menuEl.append(copyBtn, deleteBtn);
                        bodyEl.append(nameEl, textEl, menuEl);
                        annEl.append(tagEl, bodyEl);

                        let longPressTimer: number | null = null;
                        let didLongPress = false;
                        const clearLongPress = () => {
                            if (longPressTimer !== null) {
                                window.clearTimeout(longPressTimer);
                                longPressTimer = null;
                            }
                        };
                        const openMenu = () => {
                            annEl.dataset.expanded = "true";
                            menuEl.dataset.open = "true";
                            didLongPress = true;
                        };
                        bodyEl.onpointerdown = (e) => {
                            e.stopPropagation();
                            clearLongPress();
                            longPressTimer = window.setTimeout(openMenu, 500);
                        };
                        bodyEl.onpointerup = clearLongPress;
                        bodyEl.onpointercancel = clearLongPress;
                        bodyEl.onpointerleave = clearLongPress;
                        annEl.onclick = (e) => {
                            e.stopPropagation();
                            clearLongPress();
                            if (didLongPress) {
                                didLongPress = false;
                                return;
                            }
                            const isExpanded = annEl.dataset.expanded === "true";
                            annEl.dataset.expanded = isExpanded ? "false" : "true";
                            if (isExpanded) menuEl.dataset.open = "false";
                        };
                        elements.push(annEl);
                    }
                    return elements;
                };

                const buildRenderOrder = (centerPage: number) => {
                    const ordered = [centerPage];
                    for (let offset = 1; offset <= PRELOAD_RADIUS; offset += 1) {
                        ordered.push(centerPage + offset);
                        ordered.push(centerPage - offset);
                    }
                    return ordered.filter((pageNum, index, list) => pageNum >= 1 && pageNum <= pdf.numPages && list.indexOf(pageNum) === index);
                };

                const preloadNeighborhood = (centerPage: number) => {
                    for (const pageNum of buildRenderOrder(centerPage)) {
                        void renderPage(pageNum);
                    }
                };

                const renderPage = async (pageNum: number) => {
                    if (cancelled || renderSeq !== renderSeqRef.current) return;
                    if (renderedPagesRef.current.has(pageNum)) return;
                    const inFlight = renderingPagesRef.current.get(pageNum);
                    if (inFlight) {
                        await inFlight;
                        return;
                    }

                    const pageWrapper = pageWrappers.get(pageNum);
                    if (!pageWrapper) return;
                    const renderTask = (async () => {
                        const page = await pdf.getPage(pageNum);
                        const viewport = page.getViewport({ scale: 1 });
                        const cssHeight = cssWidth * (viewport.height / viewport.width);
                        const bufferWidth = Math.round(cssWidth * renderDpr * scale);
                        const bufferHeight = Math.round(cssHeight * renderDpr * scale);
                        const renderScale = bufferWidth / viewport.width;
                        const scaledViewport = page.getViewport({ scale: renderScale });

                        const canvas = document.createElement("canvas");
                        canvas.width = bufferWidth;
                        canvas.height = bufferHeight;
                        canvas.style.width = `${cssWidth}px`;
                        canvas.style.height = `${cssHeight}px`;
                        canvas.style.display = "block";
                        canvas.dataset.page = String(pageNum);

                        const ctx = canvas.getContext("2d", { alpha: false });
                        if (!ctx) throw new Error("Canvas 2D context unavailable");
                        await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
                        page.cleanup?.();

                        if (cancelled || renderSeq !== renderSeqRef.current) return;

                        renderedPagesRef.current.add(pageNum);
                        pageWrapper.style.height = `${cssHeight}px`;
                        pageWrapper.replaceChildren(canvas, ...createAnnotationPin(pageNum));
                    })();

                    renderingPagesRef.current.set(pageNum, renderTask);
                    try {
                        await renderTask;
                    } finally {
                        renderingPagesRef.current.delete(pageNum);
                    }
                };

                for (let i = 1; i <= pdf.numPages; i++) {
                    const pageWrapper = document.createElement("div");
                    pageWrapper.style.position = "relative";
                    pageWrapper.style.width = `${cssWidth}px`;
                    pageWrapper.style.height = `${defaultCssHeight}px`;
                    pageWrapper.dataset.page = String(i);
                    pageWrapper.dataset.noNav = "true";

                    const placeholder = document.createElement("div");
                    placeholder.style.width = "100%";
                    placeholder.style.height = "100%";
                    placeholder.style.borderRadius = "12px";
                    placeholder.style.background = "rgba(255, 252, 237, 0.5)";
                    pageWrapper.appendChild(placeholder);

                    pageWrappers.set(i, pageWrapper);
                    fragment.appendChild(pageWrapper);
                }

                container.replaceChildren(fragment);

                let currentPageFrame: number | null = null;
                const reportCurrentPage = () => {
                    if (!onCurrentPage || !pageRoot) return;

                    const rootRect = pageRoot.getBoundingClientRect();
                    let bestPage = 1;
                    let bestVisibleHeight = -1;
                    let bestDistance = Number.POSITIVE_INFINITY;

                    for (const [pageNum, pageWrapper] of pageWrappers.entries()) {
                        const rect = pageWrapper.getBoundingClientRect();
                        const visibleTop = Math.max(rect.top, rootRect.top);
                        const visibleBottom = Math.min(rect.bottom, rootRect.bottom);
                        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                        const distanceToTop = Math.abs(rect.top - rootRect.top);

                        if (
                            visibleHeight > bestVisibleHeight ||
                            (visibleHeight === bestVisibleHeight && distanceToTop < bestDistance)
                        ) {
                            bestPage = pageNum;
                            bestVisibleHeight = visibleHeight;
                            bestDistance = distanceToTop;
                        }
                    }

                    if (bestVisibleHeight < 0) return;
                    if (reportedPageRef.current === bestPage) return;
                    reportedPageRef.current = bestPage;
                    onCurrentPage(bestPage);
                };

                const scheduleCurrentPageReport = () => {
                    if (currentPageFrame !== null) cancelAnimationFrame(currentPageFrame);
                    currentPageFrame = requestAnimationFrame(() => {
                        currentPageFrame = null;
                        reportCurrentPage();
                    });
                };

                observerRef.current = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const pageNum = Number((entry.target as HTMLElement).dataset.page);
                        if (!pageNum) continue;
                        void renderPage(pageNum);
                        preloadNeighborhood(pageNum);
                    }
                }, { root: scrollParent, threshold: 0.01, rootMargin: PRELOAD_ROOT_MARGIN });

                for (const child of Array.from(container.children)) {
                    observerRef.current.observe(child);
                }

                const initialPage = Math.min(Math.max(jumpToPage || 1, 1), pdf.numPages);
                await renderPage(initialPage);
                preloadNeighborhood(initialPage);
                scheduleCurrentPageReport();

                pageRoot?.addEventListener("scroll", scheduleCurrentPageReport, { passive: true });
                wrapperRef.current?.addEventListener("scroll", scheduleCurrentPageReport, { passive: true });
                window.addEventListener("resize", scheduleCurrentPageReport);

                if (!cancelled && renderSeq === renderSeqRef.current) {
                    setLoading(false);
                }

                return () => {
                    if (currentPageFrame !== null) cancelAnimationFrame(currentPageFrame);
                    pageRoot?.removeEventListener("scroll", scheduleCurrentPageReport);
                    wrapperRef.current?.removeEventListener("scroll", scheduleCurrentPageReport);
                    window.removeEventListener("resize", scheduleCurrentPageReport);
                };
            } catch (err) {
                if (!cancelled && renderSeq === renderSeqRef.current) {
                    setError(`PDF 渲染失败: ${err instanceof Error ? err.message : String(err)}`);
                    setLoading(false);
                }
            }
        })().then((cleanup) => {
            if (typeof cleanup === "function") {
                if (cancelled) cleanup();
                else cleanupRef.current = cleanup;
            }
        });

        return () => {
            cancelled = true;
            observerRef.current?.disconnect();
            cleanupRef.current?.();
            cleanupRef.current = null;
        };
    }, [bilingualTranslationEnabled, chapter, collapseBilingualTranslation, docVersion, onCurrentPage, annotations, scale]);

    useEffect(() => {
        if (!jumpToPage || !canvasContainerRef.current || !wrapperRef.current) return;
        const target = canvasContainerRef.current.querySelector<HTMLElement>(`[data-page="${jumpToPage}"]`);
        if (!target) return;
        const scrollParent = canvasContainerRef.current.closest("[data-ui='body']") as HTMLElement | null;
        scrollElementWithinContainer(scrollParent || wrapperRef.current, target, { block: "start", behavior: "smooth" });
    }, [docVersion, jumpToPage]);

    // Pinch-to-zoom
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const getDist = (t: TouchList) => {
            const dx = t[0].clientX - t[1].clientX;
            const dy = t[0].clientY - t[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 2) return;
            e.preventDefault();
            const dist = getDist(e.touches);
            const sx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const sy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const wRect = wrapper.getBoundingClientRect();
            pinchRef.current = {
                startDist: dist,
                startScale: scaleRef.current,
                screenX: sx,
                screenY: sy,
                contentX: (sx - wRect.left + wrapper.scrollLeft) / scaleRef.current,
                contentY: (sy - wRect.top + wrapper.scrollTop) / scaleRef.current,
            };
        };

        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || pinchRef.current.startDist === 0) return;
            e.preventDefault();
            const dist = getDist(e.touches);
            const newScale = Math.min(Math.max(pinchRef.current.startScale * (dist / pinchRef.current.startDist), 1), 4);
            scaleRef.current = newScale;

            const container = canvasContainerRef.current;
            if (container) {
                container.style.transform = `scale(${newScale})`;
                container.style.width = `${newScale * 100}%`;
            }

            const wRect = wrapper.getBoundingClientRect();
            wrapper.scrollLeft = pinchRef.current.contentX * newScale - (pinchRef.current.screenX - wRect.left);
            wrapper.scrollTop = pinchRef.current.contentY * newScale - (pinchRef.current.screenY - wRect.top);
        };

        const onTouchEnd = () => {
            pinchRef.current.startDist = 0;
            setScale((prev) => {
                const next = scaleRef.current;
                return Math.abs(prev - next) < 0.01 ? prev : next;
            });
        };

        wrapper.addEventListener("touchstart", onTouchStart, { passive: false });
        wrapper.addEventListener("touchmove", onTouchMove, { passive: false });
        wrapper.addEventListener("touchend", onTouchEnd);
        return () => {
            wrapper.removeEventListener("touchstart", onTouchStart);
            wrapper.removeEventListener("touchmove", onTouchMove);
            wrapper.removeEventListener("touchend", onTouchEnd);
        };
    }, []);

    return (
        <div ref={wrapperRef} className="w-full" style={{ overflow: "auto", WebkitOverflowScrolling: "touch" }}>
            {loading && (
                <div className="reading-loading-view">
                    <div className="reading-loading-mark" aria-hidden="true">
                        <span className="reading-loading-page reading-loading-page--back" />
                        <span className="reading-loading-page reading-loading-page--middle" />
                        <span className="reading-loading-page reading-loading-page--front" />
                    </div>
                    <div className="reading-loading-copy">
                        <span className="reading-loading-title">
                            正在打开 PDF
                            <span className="reading-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                        </span>
                        <span className="reading-loading-subtitle">正在准备页面渲染</span>
                    </div>
                    <div className="reading-loading-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                    </div>
                </div>
            )}
            {error && <div className="text-center ts-13 text-[var(--c-danger)] py-4">{error}</div>}
            <div
                ref={canvasContainerRef}
                className="flex flex-col gap-1"
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                    width: `${scale * 100}%`,
                    willChange: "transform",
                }}
            />
            {!loading && !error && scale > 1 && (
                <div
                    className="text-center ts-11 text-[var(--c-icon)] py-2 opacity-50 cursor-pointer"
                    data-no-nav="true"
                    onClick={() => { scaleRef.current = 1; setScale(1); }}
                >
                    点击恢复原始大小
                </div>
            )}
        </div>
    );
}
