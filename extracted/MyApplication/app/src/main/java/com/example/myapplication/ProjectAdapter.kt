package com.example.myapplication

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

class ProjectAdapter(
    private val projectList: List<Project>,
    private val onAssignUserClick: (Project) -> Unit,
    private val onShowDetailsClick: (Project) -> Unit, // Add comma here
    private val onAddNoteClick: (Project) -> Unit // New callback for adding notes
) : RecyclerView.Adapter<ProjectAdapter.ViewHolder>() {

    inner class ViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val projectNameTextView: TextView = itemView.findViewById(R.id.projectNameTextView)
        val projectDescriptionTextView: TextView = itemView.findViewById(R.id.projectDescriptionTextView)
        val projectDateTextView: TextView = itemView.findViewById(R.id.projectDateTextView)
        val assignedUsersTextView: TextView = itemView.findViewById(R.id.assignedUsersTextView)
        val assignUserButton: Button = itemView.findViewById(R.id.assignUserButton)
        val showDetailsButton: Button = itemView.findViewById(R.id.showDetailsButton)
        val addNoteButton: Button = itemView.findViewById(R.id.addNoteButton) // New "Add Note" button

        init {
            // Set click listeners for buttons
            assignUserButton.setOnClickListener {
                onAssignUserClick(projectList[adapterPosition]) // Assign user action
            }

            showDetailsButton.setOnClickListener {
                onShowDetailsClick(projectList[adapterPosition]) // Show details action
            }

            addNoteButton.setOnClickListener {
                onAddNoteClick(projectList[adapterPosition]) // Add note action
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_project, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val project = projectList[position]

        holder.projectNameTextView.text = project.name
        holder.projectDescriptionTextView.text = project.description
        holder.projectDateTextView.text = project.date

        // Join assigned user names
        val assignedUserNames = project.assignedUsers.values.joinToString { it.name }
        holder.assignedUsersTextView.text = if (assignedUserNames.isNotEmpty()) {
            "Assigned Users: $assignedUserNames"
        } else {
            "No Users Assigned"
        }
    }

    override fun getItemCount() = projectList.size
}
