/**
 * Time controller for managing temporal animation
 */
export class TimeController {
    constructor(options = {}) {
        this.playing = false;
        this.speed = 1.0;
        this.loop = false;
        this.listeners = new Set();
        this.tick = () => {
            if (!this.playing)
                return;
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
                    }
                    else {
                        this.currentTime = this.timeRange.end;
                        this.pause();
                    }
                }
                else if (this.currentTime < this.timeRange.start) {
                    if (this.loop) {
                        this.currentTime = this.timeRange.end;
                    }
                    else {
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
        this.currentTime = options.initialTime || Date.now();
        this.speed = options.speed || 1.0;
        this.loop = options.loop || false;
        this.timeRange = options.timeRange;
    }
    /** Get current time */
    getTime() {
        return this.currentTime;
    }
    /** Set current time */
    setTime(time) {
        this.currentTime = time;
        this.notifyListeners();
    }
    /** Check if playing */
    isPlaying() {
        return this.playing;
    }
    /** Get playback speed */
    getSpeed() {
        return this.speed;
    }
    /** Set playback speed */
    setSpeed(speed) {
        this.speed = speed;
    }
    /** Set time range */
    setTimeRange(timeRange) {
        this.timeRange = timeRange;
    }
    /** Start playback */
    play() {
        if (this.playing)
            return;
        this.playing = true;
        this.lastUpdateTime = performance.now();
        this.tick();
    }
    /** Pause playback */
    pause() {
        this.playing = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }
    /** Toggle play/pause */
    toggle() {
        if (this.playing) {
            this.pause();
        }
        else {
            this.play();
        }
    }
    /** Seek to specific time */
    seek(time) {
        this.setTime(time);
    }
    /** Seek by relative offset */
    seekBy(delta) {
        this.setTime(this.currentTime + delta);
    }
    /** Register listener for time updates */
    on(event, callback) {
        if (event === 'tick') {
            this.listeners.add(callback);
        }
    }
    /** Unregister listener */
    off(event, callback) {
        if (event === 'tick') {
            this.listeners.delete(callback);
        }
    }
    /** Get current state */
    getState() {
        return {
            currentTime: this.currentTime,
            playing: this.playing,
            speed: this.speed,
            loop: this.loop,
        };
    }
    /** Destroy controller */
    destroy() {
        this.pause();
        this.listeners.clear();
    }
    notifyListeners() {
        for (const listener of this.listeners) {
            listener(this.currentTime);
        }
    }
}
//# sourceMappingURL=time-controller.js.map