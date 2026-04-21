//
//  ContentView.swift
//  Workout Tracker
//
//  Created by Jake on 2025-11-04.
//

import SwiftUI
import WebKit // Keep this import, but it is no longer used for embedding

// Helper to build a usable YouTube URL from the sheet field
extension WorkoutRow {
    // Builds a full URL if `Link_to_Video` is a YouTube ID or already a URL
    var youtubeFullURL: URL? {
        guard let raw = self.Link_to_Video?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              raw != "0" else { return nil }
        // If it's already a valid URL string, return it
        if let directURL = URL(string: raw), directURL.scheme != nil {
            return directURL
        }
        // Otherwise, treat it as a YouTube video ID
        let urlString = "https://www.youtube.com/watch?v=\(raw)"
        return URL(string: urlString)
    }
}

// --- 1. Main View for the Week Summary ---

struct WeekView: View {
    @EnvironmentObject var viewModel: WorkoutViewModel
    
    // State to control the confirmation dialogs
    @State private var showingResetAllConfirmation = false
    
    var body: some View {
        // Use NavigationStack for the modern iOS navigation
        NavigationStack {
            List {
                // Settings/Actions Section
                Section {
                    // Dark/Light Mode Toggle using SF Symbols
                    Button {
                        viewModel.toggleDarkMode()
                    } label: {
                        HStack {
                            Image(systemName: viewModel.isDarkMode ? "sun.max.fill" : "moon.fill")
                                .foregroundColor(viewModel.isDarkMode ? .yellow : .blue)
                            Text(viewModel.isDarkMode ? "Light Mode" : "Dark Mode")
                        }
                    }
                    
                    // Refresh Button
                    Button {
                        viewModel.fetchSheetData()
                    } label: {
                        HStack {
                            Image(systemName: "arrow.clockwise")
                                .foregroundColor(.orange)
                            Text("Refresh Workouts")
                        }
                    }
                } header: {
                    Text("App Settings")
                }
                
                // Weekly Plan Section
                Section {
                    if viewModel.isLoading {
                        HStack {
                            ProgressView()
                            Text("Loading Weekly Plan...")
                                .foregroundColor(.secondary)
                        }
                    } else if let error = viewModel.errorMessage {
                        VStack(alignment: .leading) {
                            Text("⚠️ Data Error")
                                .font(.headline)
                                .foregroundColor(.red)
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    } else {
                        // Day Summary Boxes with NavigationLink
                        ForEach(viewModel.workoutDays, id: \.self) { day in
                            DaySummaryBox(day: day)
                        }
                    }
                } header: {
                    Text("Weekly Plan")
                } footer: {
                    // Reset All Action at the bottom of the list for clarity
                    Button(role: .destructive) {
                        showingResetAllConfirmation = true
                    } label: {
                        HStack {
                            Image(systemName: "trash.fill")
                            Text("Reset All Progress")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                }
            }
            .listStyle(.insetGrouped) // Standard iOS list style
            .navigationTitle("Workout Tracker")
            // Confirmation Dialog for Reset All
            .confirmationDialog("Reset All Progress?", isPresented: $showingResetAllConfirmation, titleVisibility: .visible) {
                Button("Reset All", role: .destructive) {
                    viewModel.resetAll()
                }
            } message: {
                Text("This will clear all completion statuses. Are you sure?")
            }
        }
    }
}

// --- 2. Day Summary Box (Used in WeekView) ---

struct DaySummaryBox: View {
    @EnvironmentObject var viewModel: WorkoutViewModel
    let day: String
    
    var body: some View {
        let allWorkouts = viewModel.getDayData(day: day)
        let doneCount = allWorkouts.filter { viewModel.completedIDs.contains($0.id) }.count
        let totalCount = allWorkouts.count
        let progress = totalCount > 0 ? Double(doneCount) / Double(totalCount) : 0
        let percent = Int(progress * 100)

        NavigationLink(destination: DayDetailView(day: day)) {
            HStack {
                VStack(alignment: .leading) {
                    Text(day)
                        .font(.headline)
                    
                    // Native style Progress Bar
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color(.systemGray4))
                            .frame(height: 6)
                        Capsule()
                            .fill(Color.green)
                            // Width is relative to the progress
                            .frame(width: max(10, 150 * CGFloat(progress)), height: 6)
                    }
                    .frame(width: 150)
                }
                
                Spacer()
                
                Text("\(doneCount)/\(totalCount)")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                
                Text("\(percent)%")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(.primary)
            }
        }
    }
}

// --- 3. Day Detail View (Shows individual workouts) ---

struct DayDetailView: View {
    @EnvironmentObject var viewModel: WorkoutViewModel
    @State private var showingAddWorkout = false
    @State private var showingResetDayConfirmation = false
    @State private var showingCannotDeleteAlert = false
    
    let day: String
    
    var body: some View {
        let workouts = viewModel.getDayData(day: day)
        
        List {
            // Day Actions Section
            Section {
                Button(role: .destructive) {
                    showingResetDayConfirmation = true
                } label: {
                    HStack {
                        Image(systemName: "arrow.counterclockwise")
                        Text("Reset Day Progress")
                    }
                    .foregroundColor(.orange)
                }
            }
            
            // Workouts Section
            Section(header: Text("Workouts")) {
                ForEach(workouts, id: \.id) { workout in
                    WorkoutRowView(workout: workout)
                }
                // Allows swipe-to-delete on list rows
                .onDelete(perform: deleteWorkout)
            }
            
            // Add Workout Section
            Section {
                Button {
                    showingAddWorkout = true
                } label: {
                    Label("Add Custom Workout", systemImage: "plus.circle.fill")
                        .foregroundColor(.blue)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(day)
        
        // Confirmation Dialog for Reset Day
        .confirmationDialog("Reset \(day) Progress?", isPresented: $showingResetDayConfirmation, titleVisibility: .visible) {
            Button("Reset Day", role: .destructive) {
                viewModel.resetDay(day: day)
            }
        } message: {
            Text("This will only clear the completion status for workouts on \(day).")
        }
        
        // Alert for deletion restriction
        .alert("Cannot Delete", isPresented: $showingCannotDeleteAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Workouts loaded from the original Google Sheet cannot be deleted. Only custom-added workouts can be removed.")
        }
        
        // Presents the AddWorkoutView as a native modal sheet
        .sheet(isPresented: $showingAddWorkout) {
            AddWorkoutView(day: day)
                .environmentObject(viewModel)
        }
    }
    
    // Function to handle native swipe-to-delete logic
    func deleteWorkout(at offsets: IndexSet) {
        let allWorkouts = viewModel.getDayData(day: day)
        let originalsCount = viewModel.sheetData.filter { $0.Day == day }.count
        
        for index in offsets {
            let workoutToDelete = allWorkouts[index]
            
            // Check if the workout is a custom one (index >= original count)
            if workoutToDelete.Index >= originalsCount {
                viewModel.deleteCustomWorkout(day: day, index: workoutToDelete.Index)
            } else {
                showingCannotDeleteAlert = true
            }
        }
    }
}

// --- 4. Individual Workout Row View (Used in DayDetailView) ---

struct WorkoutRowView: View {
    @EnvironmentObject var viewModel: WorkoutViewModel
    // Get access to the external environment for opening URLs
    @Environment(\.openURL) var openURL
    let workout: WorkoutRow
    
    var body: some View {
        let isCompleted = viewModel.completedIDs.contains(workout.id)
        
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                // Checkbox/Completion Toggle - Left aligned
                Image(systemName: isCompleted ? "checkmark.circle.fill" : "circle")
                    .resizable()
                    .frame(width: 22, height: 22)
                    .foregroundColor(isCompleted ? .green : .gray)
                    .onTapGesture {
                        viewModel.toggleCompletion(id: workout.id)
                    }
                
                VStack(alignment: .leading, spacing: 4) {
                    // Title and Category
                    HStack(alignment: .firstTextBaseline) {
                        Text(workout.Workout)
                            .font(.body)
                            .fontWeight(.medium)
                            .strikethrough(isCompleted, color: .secondary)
                            .foregroundColor(isCompleted ? .secondary : .primary)
                        
                        if let category = workout.Category, !category.isEmpty {
                            Text(category)
                                .font(.caption2)
                                .foregroundColor(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.blue)
                                .cornerRadius(4)
                                .opacity(isCompleted ? 0.7 : 1.0)
                        }
                    }
                    
                    // Notes
                    if let notes = workout.Notes, !notes.isEmpty {
                        Text(notes)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            
            // --- FIX: Replaced embedded WKWebView with an action button ---
            // CONDITIONAL LOGIC CHECK ADDED: Ensure the Link_to_Video string is not empty or just a "0"
            if let url = workout.youtubeFullURL,
               let urlString = workout.Link_to_Video,
               !urlString.isEmpty,
               urlString != "0" { // Added explicit check for "0"
                
                Button {
                    // Open the URL externally, which will launch Safari or the YouTube app
                    openURL(url)
                } label: {
                    HStack {
                        Image(systemName: "play.circle.fill")
                        Text("Watch Video")
                            .fontWeight(.semibold)
                    }
                    .foregroundColor(.white)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(Color.red)
                    .cornerRadius(8)
                }
                .buttonStyle(PlainButtonStyle()) // Use plain style to avoid extra blue background
                .padding(.leading, 34) // Indent to align with text
            }
        }
    }
}

// --- 6. Add Workout Modal View (Section numbers updated due to removed YouTubeView) ---

struct AddWorkoutView: View {
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var viewModel: WorkoutViewModel
    
    let day: String
    
    @State private var workout: String = ""
    @State private var category: String = ""
    @State private var video: String = ""
    @State private var notes: String = ""
    
    var body: some View {
        NavigationView {
            Form {
                Section("Workout Details") {
                    TextField("Workout Name (Required)", text: $workout)
                    TextField("Category (Optional)", text: $category)
                }
                
                Section("Video Link") {
                    TextField("YouTube Link (optional)", text: $video)
                }
                
                Section("Notes") {
                    // Native multi-line text input
                    TextEditor(text: $notes)
                        .frame(minHeight: 150)
                }
                
                // Save button styled natively
                Button {
                    saveWorkout()
                } label: {
                    Text("Add Workout to \(day)")
                        .frame(maxWidth: .infinity)
                }
                .disabled(workout.isEmpty) // Disable if required field is empty
                .buttonStyle(.borderedProminent)
            }
            .navigationTitle("New Custom Workout")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }
    
    func saveWorkout() {
        viewModel.addWorkout(day: day, workout: workout, category: category, videoLink: video, notes: notes)
        dismiss()
    }
}

