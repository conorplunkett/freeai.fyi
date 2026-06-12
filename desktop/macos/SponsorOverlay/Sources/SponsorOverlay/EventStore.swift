// Persisted retry queue for impression/click batches. Mirrors the rules in
// overlay-core's queue.rs: ordered flush, exponential backoff, survives app
// restarts via a JSON file in Application Support. Each batch carries a stable
// batchKey so server-side idempotency dedupes replays — retries can never
// double-credit.

import Foundation

struct PendingBatch: Codable {
    var batchKey: String
    var campaignId: String
    var impressions: Int
    var clicks: Int
}

final class EventStore {
    private var pending: [PendingBatch] = []
    private var consecutiveFailures = 0
    private var nextAttempt = Date.distantPast
    private var inFlight = false
    private let fileURL: URL

    static let baseBackoff: TimeInterval = 2
    static let maxBackoff: TimeInterval = 300

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FreeAI", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("pending-events.json")
        if let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([PendingBatch].self, from: data) {
            pending = saved
        }
    }

    var count: Int { pending.count }

    func recordImpression(campaignId: String) {
        pending.append(PendingBatch(batchKey: UUID().uuidString, campaignId: campaignId, impressions: 1, clicks: 0))
        persist()
    }

    func recordClick(campaignId: String) {
        pending.append(PendingBatch(batchKey: UUID().uuidString, campaignId: campaignId, impressions: 0, clicks: 1))
        persist()
    }

    func flush(client: BackendClient, credentials: DeviceCredentials) {
        guard !inFlight, let batch = pending.first, Date() >= nextAttempt else { return }
        inFlight = true
        client.postEvents(
            credentials: credentials,
            batchKey: batch.batchKey,
            events: [["campaignId": batch.campaignId, "impressions": batch.impressions, "clicks": batch.clicks]]
        ) { [weak self] ok in
            DispatchQueue.main.async {
                guard let self else { return }
                self.inFlight = false
                if ok {
                    self.pending.removeFirst()
                    self.consecutiveFailures = 0
                    self.nextAttempt = .distantPast
                    self.persist()
                } else {
                    self.consecutiveFailures += 1
                    let backoff = min(Self.baseBackoff * pow(2, Double(min(self.consecutiveFailures, 8))), Self.maxBackoff)
                    self.nextAttempt = Date().addingTimeInterval(backoff)
                }
            }
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(pending) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
