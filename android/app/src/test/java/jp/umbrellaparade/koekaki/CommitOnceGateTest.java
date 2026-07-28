package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CommitOnceGateTest {
    @Test
    public void allowsExactlyOneCommitForTheOriginalGeneration() {
        CommitOnceGate gate = new CommitOnceGate();
        gate.start(4);
        assertTrue(gate.tryClaim(4));
        assertFalse(gate.tryClaim(4));
    }

    @Test
    public void rejectsAChangedInputGeneration() {
        CommitOnceGate gate = new CommitOnceGate();
        gate.start(4);
        assertFalse(gate.tryClaim(5));
        assertFalse(gate.tryClaim(4));
    }

    @Test
    public void rejectsLateCallbacksAfterInvalidation() {
        CommitOnceGate gate = new CommitOnceGate();
        gate.start(8);
        gate.invalidate();
        assertFalse(gate.tryClaim(8));
    }

    @Test
    public void aNewSessionGetsItsOwnSingleCommit() {
        CommitOnceGate gate = new CommitOnceGate();
        gate.start(1);
        assertTrue(gate.tryClaim(1));
        gate.start(2);
        assertTrue(gate.tryClaim(2));
        assertFalse(gate.tryClaim(2));
    }
}
