//
//  WorkoutModel.swift
//  Workout Tracker
//
//  Created by Jake on 2025-11-04.
//

import Foundation
import SwiftUI
import Combine

// --- 1. DATA MODELS (Decodable structs) ---

// Struct to match the overall JSON structure from gsx2json.com
struct SheetResponse: Decodable {
    var rows: [WorkoutRow]? // Made optional to handle entire array being missing/null
}

// Struct to match each individual workout row in the 'rows' array
struct WorkoutRow: Identifiable, Codable, Hashable {
    var id: String { "\(Day)-\(Index)" }
    
    let Day: String
    let Workout: String
    let Category: String?
    let Link_to_Video: String?
    let Notes: String?
    
    var Index: Int = 0 // Default to 0, will be assigned in ViewModel

    // Mapping the custom key "Link to Video" to a Swift-friendly variable
    private enum CodingKeys: String, CodingKey {
        case Day, Workout, Category, Notes, Link_to_Video = "Link to Video"
    }
    
    // Custom Initializer for Robust Decoding (FIXED for inconsistent data types)
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        
        // Non-optional fields
        self.Day = try container.decode(String.self, forKey: .Day)
        self.Workout = try container.decode(String.self, forKey: .Workout)
        
        // --- FIX FOR TYPE MISMATCH ERROR ---
        
        // 1. Attempt to decode Link_to_Video as a String (expected type)
        if let linkString = try? container.decodeIfPresent(String.self, forKey: .Link_to_Video) {
            self.Link_to_Video = linkString
        }
        // 2. If decoding as String fails, attempt to decode as an Int (the error indicated finding a 'number')
        else if let linkInt = try? container.decodeIfPresent(Int.self, forKey: .Link_to_Video) {
            // Convert the number (e.g., 0) into a string, which is required for the property type
            self.Link_to_Video = String(linkInt)
        }
        // 3. Otherwise, set it to nil
        else {
            self.Link_to_Video = nil
        }

        // Other Optional fields
        self.Category = try container.decodeIfPresent(String.self, forKey: .Category)
        self.Notes = try container.decodeIfPresent(String.self, forKey: .Notes)
        
        self.Index = 0
    }
    
    // Custom Initializer for creating new custom rows (used in addWorkout function)
    init(Day: String, Workout: String, Category: String?, Link_to_Video: String?, Notes: String?, Index: Int) {
        self.Day = Day
        self.Workout = Workout
        self.Category = Category
        self.Link_to_Video = Link_to_Video
        self.Notes = Notes
        self.Index = Index
    }

    var youtubeVideoID: String? {
        guard let urlString = Link_to_Video,
              let url = URL(string: urlString),
              let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return nil
        }
        return queryItems.first(where: { $0.name == "v" })?.value
    }
}

struct CustomEdits: Codable {
    var edits: [String: [WorkoutRow]] = [:]
}

// --- 2. VIEW MODEL (State Management & Persistence) ---

class WorkoutViewModel: ObservableObject {
    @Published var sheetData: [WorkoutRow] = []
    @Published var completedIDs: Set<String> = []
    @Published var customEdits: CustomEdits = CustomEdits()
    @Published var isDarkMode: Bool = false
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    
    // **CRITICAL FIX:** Added "Thursday" to the list of days the app displays.
    let workoutDays = ["Monday", "Wednesday", "Thursday", "Friday"]
    private let sheetFetchURL = "https://gsx2json.com/api?id=19HocMTEu0Sf1QTj-bRzA84o9sTUaSyKg8hIry8AT1L8&sheet=Sheet1"
    
    private let completedKey = "completedIDs"
    private let editsKey = "customEdits"
    private let darkKey = "isDarkMode"

    init() {
        loadState()
        fetchSheetData()
    }

    // --- Persistence Functions ---

    func loadState() {
        self.isDarkMode = UserDefaults.standard.bool(forKey: darkKey)

        if let savedCompleted = UserDefaults.standard.stringArray(forKey: completedKey) {
            self.completedIDs = Set(savedCompleted)
        }
        
        if let savedEdits = UserDefaults.standard.data(forKey: editsKey),
           let decodedEdits = try? JSONDecoder().decode(CustomEdits.self, from: savedEdits) {
            self.customEdits = decodedEdits
        }
    }
    
    private func saveState() {
        UserDefaults.standard.set(Array(completedIDs), forKey: completedKey)
        
        if let encodedEdits = try? JSONEncoder().encode(customEdits) {
            UserDefaults.standard.set(encodedEdits, forKey: editsKey)
        }
    }
    
    func toggleDarkMode() {
        self.isDarkMode.toggle()
        UserDefaults.standard.set(self.isDarkMode, forKey: darkKey)
    }
    
    // --- Data Fetching ---
    
    func fetchSheetData() {
        isLoading = true
        errorMessage = nil
        
        guard let url = URL(string: sheetFetchURL) else {
            errorMessage = "Invalid API URL."
            isLoading = false
            return
        }

        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isLoading = false

                if let error = error {
                    self.errorMessage = "Failed to fetch sheet data: \(error.localizedDescription)"
                    return
                }

                guard let data = data else {
                    self.errorMessage = "No data returned from sheet API."
                    return
                }
                
                do {
                    let decoder = JSONDecoder()
                    // Decode into the SheetResponse structure
                    let decodedResponse = try decoder.decode(SheetResponse.self, from: data)
                    
                    // Safely check if rows exist and process them
                    if var rows = decodedResponse.rows {
                        // Assign the Index property based on the row's position
                        for i in 0..<rows.count {
                            rows[i].Index = i
                        }
                        
                        self.sheetData = rows
                        self.errorMessage = nil
                    } else {
                        // If 'rows' key is missing or null
                        self.errorMessage = "API returned successfully but the 'rows' data structure was missing or empty."
                    }
                    
                } catch {
                    self.errorMessage = "Data decoding error: The data couldn't be read. Please check the API response format."
                    print("Decoding Error: \(error)")
                }
            }
        }.resume()
    }

    // --- Core Logic Functions ---

    func getDayData(day: String) -> [WorkoutRow] {
        let fromSheet = sheetData.filter { $0.Day == day }
        let custom = customEdits.edits[day] ?? []
        
        let nextIndex = fromSheet.count
        let reIndexedCustom = custom.enumerated().map { (index, row) -> WorkoutRow in
            var newRow = row
            newRow.Index = nextIndex + index
            return newRow
        }
        
        return fromSheet + reIndexedCustom
    }

    func toggleCompletion(id: String) {
        if completedIDs.contains(id) {
            completedIDs.remove(id)
        } else {
            completedIDs.insert(id)
        }
        saveState()
    }
    
    func resetAll() {
        completedIDs.removeAll()
        saveState()
    }
    
    func resetDay(day: String) {
        let idsToRemove = completedIDs.filter { $0.hasPrefix(day) }
        idsToRemove.forEach { completedIDs.remove($0) }
        saveState()
    }
    
    func addWorkout(day: String, workout: String, category: String, videoLink: String, notes: String) {
        let newIndex = getDayData(day: day).count
        let newWorkout = WorkoutRow(
            Day: day,
            Workout: workout,
            Category: category.isEmpty ? nil : category,
            Link_to_Video: videoLink.isEmpty ? nil : videoLink,
            Notes: notes.isEmpty ? nil : notes,
            Index: newIndex
        )
        
        if customEdits.edits[day] == nil {
            customEdits.edits[day] = []
        }
        customEdits.edits[day]?.append(newWorkout)
        saveState()
    }
    
    func deleteCustomWorkout(day: String, index: Int) {
        guard var editsForDay = customEdits.edits[day] else { return }

        if let deleteLocalIndex = editsForDay.firstIndex(where: { $0.Index == index }) {
            editsForDay.remove(at: deleteLocalIndex)
            customEdits.edits[day] = editsForDay
            
            completedIDs.remove("\(day)-\(index)")
            
            let originalsCount = sheetData.filter { $0.Day == day }.count
            for (newLocalIndex, var row) in customEdits.edits[day]!.enumerated() {
                let newIndex = originalsCount + newLocalIndex
                
                if completedIDs.contains(row.id) {
                    completedIDs.remove(row.id)
                    completedIDs.insert("\(day)-\(newIndex)")
                }
                
                row.Index = newIndex
                customEdits.edits[day]![newLocalIndex] = row
            }
            
            saveState()
        }
    }
}
