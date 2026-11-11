import { LiveReaperService } from '../src/live/live-reaper.service';

describe('LiveReaperService', () => {
  it('runs a pass and reports what it closed', async () => {
    const live = { reapAbandoned: jest.fn().mockResolvedValue(2) };
    const reaper = new LiveReaperService(live as never);

    await reaper.run();

    expect(live.reapAbandoned).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed pass rather than taking the scheduler down with it', async () => {
    const live = { reapAbandoned: jest.fn().mockRejectedValue(new Error('db down')) };
    const reaper = new LiveReaperService(live as never);

    await expect(reaper.run()).resolves.toBeUndefined();
  });
});
