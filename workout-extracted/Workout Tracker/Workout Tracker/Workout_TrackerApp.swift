//
//  Workout_TrackerApp.swift
//  Workout Tracker
//
//  Created by Jake on 2025-11-04.
//

import SwiftUI

@main
struct WorkoutTrackerApp: App {
    // Initialize the shared view model for the entire app
    @StateObject var viewModel = WorkoutViewModel()

    var body: some Scene {
        WindowGroup {
            // Set the view model as an environment object so all child views can access it
            WeekView()
                .environmentObject(viewModel)
                // Set the color scheme based on the saved state for a consistent Dark Mode experience
                .preferredColorScheme(viewModel.isDarkMode ? .dark : .light)
        }
    }
}
