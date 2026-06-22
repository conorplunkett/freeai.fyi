// HTTP client for the existing FreeAI API (server/src/app.js). The
// desktop app speaks the same protocol as the other FreeAI clients:
//   POST /v1/devices/register  -> { deviceId, deviceKey }
//   GET  /v1/ads               -> { ads: [{ id, brand, line, url, cat }] }
//   POST /v1/events            -> { batchKey, events: [{campaignId, impressions, clicks}] }
//   POST /v1/clicks/intent     -> { trackingUrl }  (forge-proof click token)
//   GET  /v1/me/earnings       -> { balanceUsd, ... }

import Foundation

struct DeviceCredentials: Codable {
    var deviceId: String
    var deviceKey: String
}

struct Ad: Codable {
    var id: String
    var brand: String
    var line: String
    var url: String
    var cat: String?
}

struct Earnings: Codable {
    var earnedUsd: Double
    var balanceUsd: Double
}

final class BackendClient {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: cfg)
    }

    static var configuredBaseURL: URL {
        let env = ProcessInfo.processInfo.environment["FREEAI_API_URL"]
            ?? UserDefaults.standard.string(forKey: "apiBaseURL")
            ?? "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api"
        return URL(string: env)!
    }

    private func post(_ path: String, body: [String: Any],
                      completion: @escaping (Result<[String: Any], Error>) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: req) { data, resp, err in
            if let err { return completion(.failure(err)) }
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                return completion(.failure(NSError(domain: "freeai", code: code)))
            }
            completion(.success(obj))
        }.resume()
    }

    private func get(_ path: String, query: [String: String] = [:],
                     completion: @escaping (Result<Data, Error>) -> Void) {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        session.dataTask(with: comps.url!) { data, resp, err in
            if let err { return completion(.failure(err)) }
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data else {
                return completion(.failure(NSError(domain: "freeai", code: (resp as? HTTPURLResponse)?.statusCode ?? -1)))
            }
            completion(.success(data))
        }.resume()
    }

    // MARK: API

    func registerDevice(completion: @escaping (DeviceCredentials?) -> Void) {
        post("v1/devices/register", body: [:]) { result in
            guard case .success(let obj) = result,
                  let id = obj["deviceId"] as? String, let key = obj["deviceKey"] as? String else {
                return completion(nil)
            }
            completion(DeviceCredentials(deviceId: id, deviceKey: key))
        }
    }

    func fetchAds(completion: @escaping ([Ad]) -> Void) {
        get("v1/ads") { result in
            guard case .success(let data) = result,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let adsJSON = obj["ads"],
                  let adsData = try? JSONSerialization.data(withJSONObject: adsJSON),
                  let ads = try? JSONDecoder().decode([Ad].self, from: adsData) else {
                return completion([])
            }
            completion(ads)
        }
    }

    func postEvents(credentials: DeviceCredentials, batchKey: String,
                    events: [[String: Any]], completion: @escaping (Bool) -> Void) {
        post("v1/events", body: [
            "deviceId": credentials.deviceId,
            "deviceKey": credentials.deviceKey,
            "batchKey": batchKey,
            "events": events,
        ]) { result in
            if case .success = result { completion(true) } else { completion(false) }
        }
    }

    /// Ask for a single-use tracking URL so clicks can't be forged client-side.
    func clickIntent(credentials: DeviceCredentials, campaignId: String,
                     completion: @escaping (URL?) -> Void) {
        post("v1/clicks/intent", body: [
            "deviceId": credentials.deviceId,
            "deviceKey": credentials.deviceKey,
            "campaignId": campaignId,
        ]) { result in
            guard case .success(let obj) = result, let s = obj["trackingUrl"] as? String else {
                return completion(nil)
            }
            completion(URL(string: s))
        }
    }

    func earnings(credentials: DeviceCredentials, completion: @escaping (Earnings?) -> Void) {
        get("v1/me/earnings", query: ["deviceId": credentials.deviceId, "deviceKey": credentials.deviceKey]) { result in
            guard case .success(let data) = result,
                  let e = try? JSONDecoder().decode(Earnings.self, from: data) else {
                return completion(nil)
            }
            completion(e)
        }
    }
}
