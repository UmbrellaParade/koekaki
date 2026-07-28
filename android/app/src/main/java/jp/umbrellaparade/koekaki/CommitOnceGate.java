package jp.umbrellaparade.koekaki;

final class CommitOnceGate {
    private int generation;
    private boolean active;
    private boolean claimed;

    void start(int inputGeneration) {
        generation = inputGeneration;
        active = true;
        claimed = false;
    }

    boolean tryClaim(int currentGeneration) {
        if (!active || claimed) return false;
        if (generation != currentGeneration) {
            invalidate();
            return false;
        }
        claimed = true;
        return true;
    }

    void invalidate() {
        active = false;
        claimed = false;
    }
}
