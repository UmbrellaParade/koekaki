package jp.umbrellaparade.koekaki;

/** Thread-safe one-shot gate used to discard cancelled, duplicate, and stale async results. */
public final class RequestEpochGate {
    private long epoch;
    private boolean active;
    private boolean claimed;

    /** Starts a new request and invalidates every previously issued epoch. */
    public synchronized long begin() {
        epoch += 1;
        active = true;
        claimed = false;
        return epoch;
    }

    public synchronized boolean isCurrent(long candidateEpoch) {
        return active && !claimed && candidateEpoch == epoch;
    }

    /** Allows exactly one completion for the current non-cancelled request. */
    public synchronized boolean tryClaim(long candidateEpoch) {
        if (!isCurrent(candidateEpoch)) return false;
        claimed = true;
        active = false;
        return true;
    }

    /** Invalidates the current request and all callbacks already in flight. */
    public synchronized void cancel() {
        epoch += 1;
        active = false;
        claimed = false;
    }
}
