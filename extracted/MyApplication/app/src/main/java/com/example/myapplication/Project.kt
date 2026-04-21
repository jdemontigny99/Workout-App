package com.example.myapplication

data class Project(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    val date: String = "",
    val assignedUsers: MutableMap<String, User> = mutableMapOf(), // Initialized as mutable
    val notes: MutableList<String> = mutableListOf(), // List to hold notes
    var images: MutableList<String> = mutableListOf()
)

