import PersonalShopperKit
import SwiftUI

/// Members of the household, with invite, join and leave.
struct HouseholdView: View {
    let session: Session
    @State private var members: [HouseholdMember] = []
    @State private var invite: HouseholdInvite?
    @State private var code = ""
    @State private var error: String?
    @State private var confirmingJoin = false

    var body: some View {
        Form {
            if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            }
            Section {
                ForEach(members) { member in
                    Text(member.you ? "\(member.email) (you)" : member.email)
                }
            } header: {
                Text("Members")
            } footer: {
                Text("Members share the same items and one Woolworths account.")
            }
            Section {
                Button("Create invite code") { Task { await createInvite() } }
                if let invite {
                    LabeledContent("Code") { Text(invite.code).textSelection(.enabled) }
                    ShareLink(item: invite.code) { Label("Share code", systemImage: "square.and.arrow.up") }
                    Text("Single use. Expires \(invite.expiresAt.formatted(date: .abbreviated, time: .shortened)).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Invite someone")
            }
            Section {
                TextField("Invite code", text: $code)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Join household") { confirmingJoin = true }
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } header: {
                Text("Join a household")
            } footer: {
                Text("Joining discards your current items if nobody else is in your household.")
            }
            if members.count > 1 {
                Section {
                    Button("Leave household", role: .destructive) { Task { await leave() } }
                }
            }
        }
        .navigationTitle("Household")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Join this household?", isPresented: $confirmingJoin, titleVisibility: .visible) {
            Button("Join", role: .destructive) { Task { await join() } }
        }
    }

    private func load() async {
        await run { members = try await session.store.client().household() }
    }

    private func createInvite() async {
        await run { invite = try await session.store.client().createInvite() }
    }

    private func join() async {
        await run {
            try await session.store.client().joinHousehold(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            code = ""
            invite = nil
            members = try await session.store.client().household()
        }
    }

    private func leave() async {
        await run {
            try await session.store.client().leaveHousehold()
            invite = nil
            members = try await session.store.client().household()
        }
    }

    private func run(_ action: () async throws -> Void) async {
        do {
            try await action()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        session.refresh()
    }
}
