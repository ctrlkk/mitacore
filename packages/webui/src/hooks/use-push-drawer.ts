import { useEffect, useEffectEvent, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

const DIRECTION_LOCK_THRESHOLD = 8;
const SPRING_STIFFNESS = 420;
const SPRING_DAMPING = 38;
const SWIPE_VELOCITY_THRESHOLD = 0.5;

type Gesture = {
  direction: "pending" | "horizontal" | "vertical";
  lastPosition: number;
  lastTime: number;
  pointerId: number;
  startPosition: number;
  startX: number;
  startY: number;
  velocity: number;
};

type UsePushDrawerOptions = {
  drawerWidth: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function usePushDrawer({ drawerWidth, open, onOpenChange }: UsePushDrawerOptions) {
  const contentRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const animationFrame = useRef<number | null>(null);
  const drawerX = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const internalOpenChange = useRef(false);

  function stopAnimation() {
    if (animationFrame.current === null) {
      return;
    }

    cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
  }

  function setDrawerX(value: number) {
    const position = clamp(value, 0, drawerWidth);
    const progress = drawerWidth === 0 ? 0 : position / drawerWidth;

    drawerX.current = position;

    if (contentRef.current) {
      contentRef.current.style.transform = `translate3d(${position}px, 0, 0)`;
      contentRef.current.style.boxShadow = `-12px 0 30px rgb(0 0 0 / ${progress * 0.2})`;
    }

    if (scrimRef.current) {
      scrimRef.current.style.opacity = `${progress * 0.12}`;
    }
  }

  function animateTo(target: number) {
    stopAnimation();

    if (Math.abs(target - drawerX.current) < 0.01) {
      setDrawerX(target);
      return;
    }

    let lastTime = performance.now();
    let velocity = 0;

    function step(now: number) {
      const elapsed = Math.min((now - lastTime) / 1000, 0.064);
      const distance = target - drawerX.current;
      const acceleration = distance * SPRING_STIFFNESS - velocity * SPRING_DAMPING;

      velocity += acceleration * elapsed;
      setDrawerX(drawerX.current + velocity * elapsed);
      lastTime = now;

      if (Math.abs(target - drawerX.current) < 0.5 && Math.abs(velocity) < 5) {
        setDrawerX(target);
        animationFrame.current = null;
        return;
      }

      animationFrame.current = requestAnimationFrame(step);
    }

    animationFrame.current = requestAnimationFrame(step);
  }

  function settle(openDrawer: boolean) {
    animateTo(openDrawer ? drawerWidth : 0);

    if (open === openDrawer) {
      return;
    }

    internalOpenChange.current = true;
    onOpenChange(openDrawer);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || !event.isPrimary) {
      return;
    }

    stopAnimation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = {
      direction: "pending",
      lastPosition: drawerX.current,
      lastTime: performance.now(),
      pointerId: event.pointerId,
      startPosition: drawerX.current,
      startX: event.clientX,
      startY: event.clientY,
      velocity: 0,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const currentGesture = gesture.current;

    if (!currentGesture || currentGesture.pointerId !== event.pointerId) {
      return;
    }

    const horizontalDistance = event.clientX - currentGesture.startX;
    const verticalDistance = event.clientY - currentGesture.startY;

    if (currentGesture.direction === "pending") {
      if (Math.max(Math.abs(horizontalDistance), Math.abs(verticalDistance)) < DIRECTION_LOCK_THRESHOLD) {
        return;
      }

      currentGesture.direction = Math.abs(horizontalDistance) > Math.abs(verticalDistance) ? "horizontal" : "vertical";
    }

    if (currentGesture.direction !== "horizontal") {
      return;
    }

    event.preventDefault();

    const position = clamp(currentGesture.startPosition + horizontalDistance, 0, drawerWidth);
    const now = performance.now();
    const elapsed = now - currentGesture.lastTime;

    if (elapsed > 0) {
      currentGesture.velocity = (position - currentGesture.lastPosition) / elapsed;
    }

    currentGesture.lastPosition = position;
    currentGesture.lastTime = now;
    setDrawerX(position);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const currentGesture = gesture.current;
    gesture.current = null;

    if (!currentGesture || currentGesture.pointerId !== event.pointerId || currentGesture.direction !== "horizontal") {
      return;
    }

    if (currentGesture.velocity > SWIPE_VELOCITY_THRESHOLD) {
      settle(true);
      return;
    }

    if (currentGesture.velocity < -SWIPE_VELOCITY_THRESHOLD) {
      settle(false);
      return;
    }

    settle(drawerX.current > drawerWidth / 2);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const currentGesture = gesture.current;
    gesture.current = null;

    if (!currentGesture || currentGesture.pointerId !== event.pointerId || currentGesture.direction !== "horizontal") {
      return;
    }

    settle(drawerX.current > drawerWidth / 2);
  }

  const synchronizeDrawer = useEffectEvent(() => {
    if (internalOpenChange.current) {
      internalOpenChange.current = false;
      return;
    }

    animateTo(open ? drawerWidth : 0);
  });

  useEffect(() => {
    synchronizeDrawer();
  }, [drawerWidth, open]);

  useEffect(() => stopAnimation, []);

  return {
    contentRef,
    drawerHandlers: {
      onPointerCancel: handlePointerCancel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
    scrimRef,
    close: () => settle(false),
  } satisfies {
    close: () => void;
    contentRef: RefObject<HTMLDivElement | null>;
    drawerHandlers: {
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
    };
    scrimRef: RefObject<HTMLButtonElement | null>;
  };
}
