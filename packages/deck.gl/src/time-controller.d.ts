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
    timeRange?: {
        start: number;
        end: number;
    };
}
export interface TimeControllerState {
    currentTime: number;
    playing: boolean;
    speed: number;
    loop: boolean;
}
export type TimeUpdateCallback = (time: number) => void;
export declare class TimeController {
    private currentTime;
    private playing;
    private speed;
    private loop;
    private timeRange?;
    private listeners;
    private animationFrameId?;
    private lastUpdateTime?;
    constructor(options?: TimeControllerOptions);
    /** Get current time */
    getTime(): number;
    /** Set current time */
    setTime(time: number): void;
    /** Check if playing */
    isPlaying(): boolean;
    /** Get playback speed */
    getSpeed(): number;
    /** Set playback speed */
    setSpeed(speed: number): void;
    /** Set time range */
    setTimeRange(timeRange: {
        start: number;
        end: number;
    }): void;
    /** Start playback */
    play(): void;
    /** Pause playback */
    pause(): void;
    /** Toggle play/pause */
    toggle(): void;
    /** Seek to specific time */
    seek(time: number): void;
    /** Seek by relative offset */
    seekBy(delta: number): void;
    /** Register listener for time updates */
    on(event: 'tick', callback: TimeUpdateCallback): void;
    /** Unregister listener */
    off(event: 'tick', callback: TimeUpdateCallback): void;
    /** Get current state */
    getState(): TimeControllerState;
    /** Destroy controller */
    destroy(): void;
    private tick;
    private notifyListeners;
}
//# sourceMappingURL=time-controller.d.ts.map