package com.example.myapplication

import android.app.DatePickerDialog
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.firebase.database.*
import java.util.*
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import java.text.SimpleDateFormat
import NotesAdapter
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.storage.FirebaseStorage
//import kotlin.coroutines.jvm.internal.CompletedContinuation.context


class MainActivity : AppCompatActivity() {

    private lateinit var projectLayout: LinearLayout
    private lateinit var userLayout: LinearLayout
    private lateinit var showProjectsButton: Button
    private lateinit var showUsersButton: Button
    private lateinit var addProjectButton: Button
    private lateinit var addUserButton: Button
    private val projectList = mutableListOf<Project>()
    private val userList = mutableListOf<User>()
    private lateinit var recyclerViewProjects: RecyclerView
    private lateinit var recyclerViewUsers: RecyclerView
    private lateinit var database: FirebaseDatabase
    private lateinit var projectRef: DatabaseReference
    private lateinit var userRef: DatabaseReference
    private var currentProject: Project? = null // Declare project here
    private val IMAGE_PICK_REQUEST_CODE = 1001 // Example request code for image picking
    private lateinit var imagesRecyclerView: RecyclerView
    private val imageList = mutableListOf<String>()


    private var showDetails = false // Default to showing only name and date


    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main) // Only keep this line

        // Initialize views

        imagesRecyclerView = findViewById(R.id.imagesRecyclerView) // Ensure this is called after setContentView
        imagesRecyclerView.layoutManager = LinearLayoutManager(this)
        val imageList = mutableListOf<String>() // List to hold image URIs
        imagesRecyclerView.adapter = ImagesAdapter(imageList)

        // Initialize Firebase references
        database = FirebaseDatabase.getInstance()
        projectRef = database.getReference("projects")
        userRef = database.getReference("users")

        // Initialize other buttons and layouts
        projectLayout = findViewById(R.id.projectLayout)
        userLayout = findViewById(R.id.userLayout)
        showProjectsButton = findViewById(R.id.showProjectsButton)
        showUsersButton = findViewById(R.id.showUsersButton)
        addProjectButton = findViewById(R.id.addProjectButton)
        addUserButton = findViewById(R.id.addUserButton)

        // Set up RecyclerViews
        setupRecyclerViews()

        // Set up buttons
        showProjectsButton.setOnClickListener {
            Log.d("MainActivity", "Show Projects clicked")
            toggleVisibility(projectLayout)
        }

        showUsersButton.setOnClickListener {
            toggleVisibility(userLayout)
        }
        addProjectButton.setOnClickListener {
            showAddProjectDialog()
        }
        addUserButton.setOnClickListener {
            showAddUserDialog()
        }

        // Fetch data from Firebase
        fetchProjects()
        fetchUsers()
    }

    private fun setupRecyclerViews() {
        val projectAdapter = ProjectAdapter(projectList, { project ->
            showAssignUserDialog(project) // Handle the assign user dialog
        }, { project ->
            showProjectDetailsDialog(project) // Show project details dialog
        }, { project ->
            showAddNoteDialog(project) })

        val recyclerViewProjects = findViewById<RecyclerView>(R.id.recyclerViewProjects)
        recyclerViewProjects.layoutManager = LinearLayoutManager(this)
        recyclerViewProjects.adapter = projectAdapter

        // Set up user adapter
        val userAdapter = UserAdapter(userList)
        val recyclerViewUsers = findViewById<RecyclerView>(R.id.recyclerViewUsers)
        recyclerViewUsers.layoutManager = LinearLayoutManager(this)
        recyclerViewUsers.adapter = userAdapter
    }

    private fun toggleVisibility(layoutToShow: View) {
        Log.d("MainActivity", "Toggling visibility for: ${layoutToShow.id}")

        // Hide both layouts initially
        projectLayout.visibility = View.GONE
        userLayout.visibility = View.GONE

        // Show the selected layout
        layoutToShow.visibility = View.VISIBLE
        Log.d("MainActivity", "Current Visibility -> Project: ${projectLayout.visibility}, User: ${userLayout.visibility}")
    }

    private fun showAddProjectDialog() {
        val builder = AlertDialog.Builder(this)
        val view = layoutInflater.inflate(R.layout.dialog_add_project, null)

        val projectNameInput = view.findViewById<EditText>(R.id.projectNameInput)
        val projectDescriptionInput = view.findViewById<EditText>(R.id.projectDescriptionInput)
        val projectDateInput = view.findViewById<EditText>(R.id.projectDateInput)

        // Set up a date picker dialog
        projectDateInput.setOnClickListener {
            val calendar = Calendar.getInstance()
            val year = calendar.get(Calendar.YEAR)
            val month = calendar.get(Calendar.MONTH)
            val day = calendar.get(Calendar.DAY_OF_MONTH)

            val datePickerDialog = DatePickerDialog(this, { _, selectedYear, selectedMonth, selectedDay ->
                val selectedDate = "$selectedDay/${selectedMonth + 1}/$selectedYear"
                projectDateInput.setText(selectedDate)
            }, year, month, day)

            datePickerDialog.show()
        }

        builder.setView(view)
            .setTitle("Add Project")
            .setPositiveButton("Add") { _, _ ->
                val projectName = projectNameInput.text.toString().trim()
                val projectDescription = projectDescriptionInput.text.toString().trim()
                val projectDate = projectDateInput.text.toString().trim()

                if (projectName.isNotEmpty() && projectDescription.isNotEmpty() && projectDate.isNotEmpty()) {
                    val projectId = projectRef.push().key ?: return@setPositiveButton
                    val project = Project(projectId, projectName, projectDescription, projectDate)
                    projectRef.child(projectId).setValue(project)
                        .addOnSuccessListener { Toast.makeText(this, "Project added", Toast.LENGTH_SHORT).show() }
                        .addOnFailureListener { Toast.makeText(this, "Failed to add project", Toast.LENGTH_SHORT).show() }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showAddUserDialog() {
        val builder = AlertDialog.Builder(this)
        val view = layoutInflater.inflate(R.layout.dialog_add_user, null)
        val userNameInput = view.findViewById<EditText>(R.id.userNameInput)

        builder.setView(view)
            .setTitle("Add User")
            .setPositiveButton("Add") { _, _ ->
                val userName = userNameInput.text.toString().trim()
                if (userName.isNotEmpty()) {
                    val userId = userRef.push().key ?: return@setPositiveButton
                    val user = User(userId, userName)
                    userRef.child(userId).setValue(user)
                        .addOnSuccessListener { Toast.makeText(this, "User added", Toast.LENGTH_SHORT).show() }
                        .addOnFailureListener { Toast.makeText(this, "Failed to add user", Toast.LENGTH_SHORT).show() }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showAssignUserDialog(project: Project) {
        val builder = AlertDialog.Builder(this)
        val view = layoutInflater.inflate(R.layout.dialog_assign_user, null)
        val userSpinner = view.findViewById<Spinner>(R.id.userSpinner)

        // Set up the spinner to display user names
        val userNames = userList.map { it.name }
        val userAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, userNames)
        userAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        userSpinner.adapter = userAdapter

        builder.setView(view)
            .setTitle("Assign User to Project")
            .setPositiveButton("Assign") { _, _ ->
                val selectedUserName = userSpinner.selectedItem as? String
                val selectedUser = userList.find { it.name == selectedUserName }

                if (selectedUser != null) {
                    // Add selected user to the project’s assigned users
                    project.assignedUsers[selectedUser.id] = selectedUser

                    // Update project in Firebase
                    projectRef.child(project.id).setValue(project)
                        .addOnSuccessListener {
                            Toast.makeText(this, "User assigned successfully", Toast.LENGTH_SHORT).show()
                            (findViewById<RecyclerView>(R.id.recyclerViewProjects).adapter as ProjectAdapter).notifyDataSetChanged()
                        }
                        .addOnFailureListener {
                            Toast.makeText(this, "Failed to assign user", Toast.LENGTH_SHORT).show()
                        }
                } else {
                    Toast.makeText(this, "User not found", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showProjectDetailsDialog(project: Project) {
        currentProject = project
        val builder = AlertDialog.Builder(this)
        val view = layoutInflater.inflate(R.layout.dialog_project_details, null)

        val projectDetailsTextView = view.findViewById<TextView>(R.id.projectDetailsTextView)
        val viewImagesButton = view.findViewById<Button>(R.id.viewImagesButton)
        val addImageButton = view.findViewById<Button>(R.id.addImageButton)

        // Set project details text
        val projectDetails = StringBuilder().apply {
            append("Project Name: ${project.name}\n")
            append("Description: ${project.description}\n")
            append("Date: ${project.date}\n")
            append("Assigned Installers: ${project.assignedUsers.values.joinToString { it.name }}\n")
            append("\nNotes:\n")
            project.notes.forEachIndexed { index, note -> append("${index + 1}. $note\n") }
        }
        projectDetailsTextView.text = projectDetails.toString()

        // Assuming the project can have multiple images and we want to show them in the viewer
        viewImagesButton.setOnClickListener {
            if (project.images.isNotEmpty()) {
                // Start the ImageViewerActivity with all image URIs
                val intent = Intent(this, ImageViewerActivity::class.java)
                intent.putStringArrayListExtra("imageUris", ArrayList(project.images)) // Pass the entire image list
                startActivity(intent)
            } else {
                Toast.makeText(this, "No images available", Toast.LENGTH_SHORT).show()
            }
        }

        addImageButton.setOnClickListener {
            showAddImageDialog(project, imagesRecyclerView)
        }

        builder.setView(view)
            .setTitle("Project Details")
            .setPositiveButton("OK", null)
            .show()
    }


    private fun showAddImageDialog(project: Project, imagesRecyclerView: RecyclerView) {
        // Check for the READ_MEDIA_IMAGES permission
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_MEDIA_IMAGES)
            != PackageManager.PERMISSION_GRANTED) {
            // Request the permission
            ActivityCompat.requestPermissions(
                this,
                arrayOf(android.Manifest.permission.READ_MEDIA_IMAGES),
                IMAGE_PICK_REQUEST_CODE
            )
        } else {
            // Permission is already granted, proceed to pick an image
            pickImageFromGallery()
        }
    }

    private fun pickImageFromGallery() {
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        startActivityForResult(intent, IMAGE_PICK_REQUEST_CODE)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == IMAGE_PICK_REQUEST_CODE && resultCode == RESULT_OK) {
            data?.data?.let { uri ->
                currentProject?.let { project ->
                    uploadImageToFirebase(uri, project)
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == IMAGE_PICK_REQUEST_CODE) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                // Permission granted, proceed to pick an image
                pickImageFromGallery()
            } else {
                Toast.makeText(this, "Permission denied to read images", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun uploadImageToFirebase(uri: Uri, project: Project) {
        val storageRef = FirebaseStorage.getInstance().reference
        val imageRef = storageRef.child("images/${uri.lastPathSegment}")
        val projectRef = FirebaseDatabase.getInstance().getReference("projects")

        imageRef.putFile(uri)
            .addOnSuccessListener { taskSnapshot ->
                imageRef.downloadUrl.addOnSuccessListener { downloadUri ->
                    // Add the image URL to the project's images list
                    project.images.add(downloadUri.toString())
                    // Update project in Firebase
                    projectRef.child(project.id).setValue(project)
                        .addOnSuccessListener {
                            // Now update the RecyclerView to show the new image
                            updateImagesRecyclerView(imagesRecyclerView, project)
                        }
                }
            }
            .addOnFailureListener { exception ->
                Log.e("ImageUpload", "Failed to upload image: ${exception.message}")
            }
    }

    private fun updateImagesRecyclerView(recyclerView: RecyclerView, project: Project) {
        val adapter = ImagesAdapter(project.images)
        recyclerView.adapter = adapter
        adapter.notifyDataSetChanged() // Refresh adapter to show new images
    }

    private fun fetchProjects() {
        projectRef.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                projectList.clear()
                snapshot.children.forEach { projectSnapshot ->
                    val project = projectSnapshot.getValue(Project::class.java)
                    project?.let { projectList.add(it) }
                }

                // Sort projects by due date
                val dateFormat = SimpleDateFormat("dd/MM/yyyy", Locale.getDefault())
                projectList.sortBy { project ->
                    try {
                        dateFormat.parse(project.date)
                    } catch (e: Exception) {
                        null
                    }
                }

                // Notify adapter of data change
                (findViewById<RecyclerView>(R.id.recyclerViewProjects).adapter as ProjectAdapter).notifyDataSetChanged()
            }

            override fun onCancelled(error: DatabaseError) {
                Toast.makeText(this@MainActivity, "Failed to load projects", Toast.LENGTH_SHORT).show()
            }
        })
    }

    private fun fetchUsers() {
        userRef.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                userList.clear()
                snapshot.children.forEach { userSnapshot ->
                    val user = userSnapshot.getValue(User::class.java)
                    user?.let { userList.add(it) }
                }
                // Notify adapter of data change
                (findViewById<RecyclerView>(R.id.recyclerViewUsers).adapter as UserAdapter).notifyDataSetChanged()
            }

            override fun onCancelled(error: DatabaseError) {
                Toast.makeText(this@MainActivity, "Failed to load users", Toast.LENGTH_SHORT).show()
            }
        })
    }

    private fun showAddNoteDialog(project: Project) {
        val builder = AlertDialog.Builder(this)
        val view = layoutInflater.inflate(R.layout.dialog_add_note, null)
        val noteInput = view.findViewById<EditText>(R.id.noteInput)

        builder.setView(view)
            .setTitle("Add Note to Project")
            .setPositiveButton("Add") { _, _ ->
                val noteText = noteInput.text.toString().trim()
                if (noteText.isNotEmpty()) {
                    // Add note to the project and update Firebase
                    project.notes.add(noteText) // Assuming Project has a `notes` field as a list
                    projectRef.child(project.id).setValue(project) // Update Firebase
                        .addOnSuccessListener { Toast.makeText(this, "Note added", Toast.LENGTH_SHORT).show() }
                        .addOnFailureListener { Toast.makeText(this, "Failed to add note", Toast.LENGTH_SHORT).show() }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

}