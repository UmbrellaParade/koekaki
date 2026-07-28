package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RequestEpochGateTest {
    @Test
    public void currentEpochCanBeClaimedOnlyOnce() {
        RequestEpochGate gate = new RequestEpochGate();
        long epoch = gate.begin();

        assertTrue(gate.isCurrent(epoch));
        assertTrue(gate.tryClaim(epoch));
        assertFalse(gate.isCurrent(epoch));
        assertFalse(gate.tryClaim(epoch));
    }

    @Test
    public void newRequestRejectsOlderEpoch() {
        RequestEpochGate gate = new RequestEpochGate();
        long oldEpoch = gate.begin();
        long newEpoch = gate.begin();

        assertFalse(gate.tryClaim(oldEpoch));
        assertTrue(gate.tryClaim(newEpoch));
    }

    @Test
    public void cancelRejectsCallbackAndFutureBeginStillWorks() {
        RequestEpochGate gate = new RequestEpochGate();
        long cancelledEpoch = gate.begin();
        gate.cancel();

        assertFalse(gate.isCurrent(cancelledEpoch));
        assertFalse(gate.tryClaim(cancelledEpoch));

        long nextEpoch = gate.begin();
        assertTrue(gate.tryClaim(nextEpoch));
    }
}
