import Testing

@testable import PersonalShopperKit

struct DoneSpeechTests {
    @Test(arguments: ["That's it", "that’s it.", "  Done ", "That is all!", "nothing else", "No more"])
    func recognisesDone(_ spoken: String) {
        #expect(DoneSpeech.isDone(spoken))
    }

    @Test(arguments: ["milk", "done milk", "bread", ""])
    func ignoresItems(_ spoken: String) {
        #expect(!DoneSpeech.isDone(spoken))
    }
}
