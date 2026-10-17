import Foundation

/// Recognises the spoken phrase that ends a run of items, e.g. "that's it".
public enum DoneSpeech {
    private static let phrases: Set<String> = [
        "done", "finished", "stop", "that is it", "that is all", "that is everything",
        "thats it", "thats all", "thats everything", "nothing", "nothing else", "no more", "im done", "i am done",
    ]

    public static func isDone(_ spoken: String) -> Bool {
        let letters = spoken.lowercased().filter { $0.isLetter || $0.isWhitespace }
        return phrases.contains(letters.split(separator: " ").joined(separator: " "))
    }
}
