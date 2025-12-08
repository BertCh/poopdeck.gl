/**
 * Time controller for managing temporal animation
 */

export interface TimeControllerOptions {
  /** Initial time (Unix milliseconds) */
  initialTime?: number;
  /** Playback speed multiplier (1.0 = real-time) */
  speed?: number;
  /** Loop animation */
  loop?: boolean;
  /** Time range */
  timeRange?: { start: number; end: number };
}

export interface TimeControllerState {
  currentTime: number;
  playing: boolean;
  speed: number;
  loop: boolean;
}

export type TimeUpdateCallback = (time: number) => void;
export type PlayStateCallback = (playing: boolean, speed: number) => void;

export class TimeController {
  private currentTime: number;
  private playing: boolean = false;
  private speed: number = 1.0;
  private loop: boolean = false;
  private timeRange?: { start: number; end: number };
  private listeners: Set<TimeUpdateCallback> = new Set();
  private playStateListeners: Set<PlayStateCallback> = new Set();
  private animationFrameId?: number;
  private lastUpdateTime?: number;

  constructor(options: TimeControllerOptions = {}) {
    this.currentTime = options.initialTime || Date.now();
    this.speed = options.speed || 1.0;
    this.loop = options.loop || false;
    this.timeRange = options.timeRange;
  }

  /** Get current time */
  getTime(): number {
    return this.currentTime;
  }

  /** Set current time */
  setTime(time: number): void {
    this.currentTime = time;
    this.notifyListeners();
  }

  /** Check if playing */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Get playback speed */
  getSpeed(): number {
    return this.speed;
  }

  /** Set playback speed */
  setSpeed(speed: number): void {
    this.speed = speed;
    if (this.playing) {
      this.notifyPlayStateListeners();
    }
  }

  /** Set time range */
  setTimeRange(timeRange: { start: number; end: number }): void {
    this.timeRange = timeRange;
  }

  /** Start playback */
  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastUpdateTime = performance.now();
    this.notifyPlayStateListeners();
    this.tick();
  }

  /** Pause playback */
  pause(): void {
    this.playing = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    this.notifyPlayStateListeners();
  }

  /** Toggle play/pause */
  toggle(): void {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  /** Seek to specific time */
  seek(time: number): void {
    this.setTime(time);
  }

  /** Seek by relative offset */
  seekBy(delta: number): void {
    this.setTime(this.currentTime + delta);
  }

  /** Register listener for time updates */
  on(event: 'tick', callback: TimeUpdateCallback): void;
  on(event: 'playState', callback: PlayStateCallback): void;
  on(event: string, callback: TimeUpdateCallback | PlayStateCallback): void {
    if (event === 'tick') {
      this.listeners.add(callback as TimeUpdateCallback);
    } else if (event === 'playState') {
      this.playStateListeners.add(callback as PlayStateCallback);
    }
  }

  /** Unregister listener */
  off(event: 'tick', callback: TimeUpdateCallback): void;
  off(event: 'playState', callback: PlayStateCallback): void;
  off(event: string, callback: TimeUpdateCallback | PlayStateCallback): void {
    if (event === 'tick') {
      this.listeners.delete(callback as TimeUpdateCallback);
    } else if (event === 'playState') {
      this.playStateListeners.delete(callback as PlayStateCallback);
    }
  }

  /** Get current state */
  getState(): TimeControllerState {
    return {
      currentTime: this.currentTime,
      playing: this.playing,
      speed: this.speed,
      loop: this.loop,
    };
  }

  /** Destroy controller */
  destroy(): void {
    this.pause();
    this.listeners.clear();
  }

  private tick = (): void => {
    if (!this.playing) return;

    const now = performance.now();
    const elapsed = this.lastUpdateTime ? now - this.lastUpdateTime : 0;
    this.lastUpdateTime = now;

    // Update time based on elapsed time and speed
    const timeIncrement = elapsed * this.speed;
    this.currentTime += timeIncrement;

    // Handle time range boundaries
    if (this.timeRange) {
      if (this.currentTime > this.timeRange.end) {
        if (this.loop) {
          this.currentTime = this.timeRange.start;
        } else {
          this.currentTime = this.timeRange.end;
          this.pause();
        }
      } else if (this.currentTime < this.timeRange.start) {
        if (this.loop) {
          this.currentTime = this.timeRange.end;
        } else {
          this.currentTime = this.timeRange.start;
          this.pause();
        }
      }
    }

    this.notifyListeners();

    // Schedule next frame
    if (this.playing) {
      this.animationFrameId = requestAnimationFrame(this.tick);
    }
  };

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentTime);
    }
  }

  private notifyPlayStateListeners(): void {
    for (const listener of this.playStateListeners) {
      listener(this.playing, this.speed);
    }
  }
}

